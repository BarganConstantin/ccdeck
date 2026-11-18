// Usage and This machine never float over the board (critique 3, point 5).
//
// On a desktop Board the two live in the right column with the Inspector: one
// grid track at the right, the canvas ending at its left edge. With the
// Inspector open a panel it folded is one row at the top of that column, and
// opens in place above it; with no Inspector an open panel has the column
// alone. These read the real sheet the way a browser cascades it
// (sheet-cascade.ts) at 1280x800 and 1440x900, with the Inspector, Usage and
// This machine all open, and lay the row out: no panel's box may reach into
// the canvas's. The fit is then the canvas that is left (railCover finds
// nothing over it), and App's wiring and the phone are read where they live.
// Both panels are drawn with the Inspector open and without it: opened beside
// it, the title is the row button with the up chevron that folds it back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cascade, el, selects, splitTop, type El } from "./sheet-cascade";
import { railCover } from "../use-layout-frame";
import type { PanelDock } from "../side-column";

vi.mock("../use-system", () => ({ useSystem: () => null }));
vi.mock("../use-usage-range", () => ({
  useUsageRange: () => ({ data: null, shown: "today", stale: false, loading: false, baseline: null, tried: true }),
}));
const { default: MachinePanel } = await import("../components/MachinePanel");
const { default: UsagePanel } = await import("../components/UsagePanel");
const { initialState } = await import("../reducer");
const { ASSUMED } = await import("../providers");

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ANY = "[data-any]";
const NEVER = "[data-never]";

/** `sel` with every `:has(…)` and `:not(:has(…))` written as `decide` says. */
function mapHas(sel: string, decide: (list: string, negated: boolean) => string): string {
  let out = "";
  for (let i = 0; i < sel.length;) {
    const negated = sel.startsWith(":not(:has(", i);
    if (negated || sel.startsWith(":has(", i)) {
      const open = i + (negated ? ":not(:has(".length : ":has(".length);
      let depth = 1, j = open;
      for (; j < sel.length && depth > 0; j++) {
        if (sel[j] === "(") depth++;
        else if (sel[j] === ")") depth--;
      }
      out += decide(sel.slice(open, j - 1), negated);
      i = negated ? j + 1 : j;
      continue;
    }
    out += sel[i++];
  }
  return out;
}

/** How heavily `sel` selects the chain's last element when the classes in
 *  `present` are somewhere in the page: `:has()` is read against them, and
 *  only for a rule that could reach the element at all. */
function weigh(sel: string, chain: readonly El[], present: ReadonlySet<string>): number | null {
  if (selects(mapHas(sel, () => ANY), chain) == null) return null;
  return selects(mapHas(sel, (list, negated) => {
    const hit = splitTop(list).some(item => {
      const m = /^\.([\w-]+)$/.exec(item.trim());
      if (!m) throw new Error(`unread :has(${list}) in ${sel}`);
      return present.has(m[1]!);
    });
    return hit !== negated ? ANY : NEVER;
  }), chain);
}

/** One element of the page, carrying the attribute `ANY` asks for. */
const node = (tag: string, classes: string[] = [], attrs: Record<string, string> = {}) =>
  el(tag, classes, { attrs: { "data-any": "", ...attrs } });

/** A length the root declares, through any var() it names. */
function rootPx(name: string, width: number): number {
  const v = cascade(sel => selects(sel, [el("html", [], { states: ["root"] })]), name, width);
  expect(v, `${name} is declared`).toBeTruthy();
  const named = /^var\((--[\w-]+)\)$/.exec(v!);
  if (named) return rootPx(named[1]!, width);
  expect(v).toMatch(/^\d+px$/);
  return parseFloat(v!);
}

type Box = { left: number; right: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right;

/** The row laid out at `width`, on a desktop Board with the right column up:
 *  the Inspector open (or not), Usage and This machine open, the Sessions
 *  list open (or not). Each box's left and right, in px. */
function layout(width: number, p: { inspector: boolean; sessions: boolean }) {
  const present = new Set<string>(["right-col", "ws-side", "usage-panel", "sysdetail", "canvas-wrap"]);
  if (p.inspector) present.add("detail");
  if (p.sessions) { present.add("left-column"); present.add("session-list"); }
  const app = node("div", ["app"], { "data-right-col": "" });
  const page = [el("html", [], { states: ["root"], attrs: { "data-any": "" } }), node("body"), app];
  const at = (chain: El[], prop: string) => cascade(sel => weigh(sel, chain, present), prop, width);

  const template = at(page, "grid-template-columns")!;
  const edge = rootPx("--edge-w", width);
  const inspectorW = rootPx("--inspector-w", width);
  const listW = rootPx("--rail-w", width);
  const tracks = splitTop(template.replace(/\s+(?![^(]*\))/g, ","));
  const room = width - 2 * edge;
  const fixed = tracks.map(t => (t === "var(--inspector-w)" ? inspectorW : t === "auto" ? listW : /fr$/.test(t) ? 0 : NaN));
  expect(fixed.some(Number.isNaN), `a track this cannot read: ${template}`).toBe(false);
  const flex = room - fixed.reduce((a, b) => a + b, 0);
  const sizes = tracks.map((t, i) => (/fr$/.test(t) ? flex : fixed[i]!));
  const lines = sizes.reduce<number[]>((acc, s) => [...acc, acc.at(-1)! + s], [edge]);
  /** A track span, `a` or `a / b`, negative lines counted from the end. */
  const span = (value: string): Box => {
    const [a, b] = value.split("/").map(s => parseInt(s.trim(), 10));
    const line = (n: number) => (n < 0 ? lines.length + n : n - 1);
    return { left: lines[line(a!)]!, right: lines[line(b ?? a! + 1)]! };
  };

  const canvas = span(at([...page, node("main", ["canvas-wrap"])], "grid-column")!);
  const col = [...page, node("div", ["right-col"])];
  const column = span(at(col, "grid-column")!);
  const side = [...col, node("div", ["ws-side"])];
  const panel = (cls: string) => {
    const chain = [...side, node("aside", [cls])];
    return { position: at(chain, "position"), width: at(chain, "width"), maxHeight: at(chain, "max-height") };
  };
  return {
    template, canvas, column, edge,
    columnDisplay: at(col, "display"), columnPosition: at(col, "position"), columnFlow: at(col, "flex-direction"),
    columnOverflow: at(col, "overflow"), sideDisplay: at(side, "display"),
    usage: panel("usage-panel"), machine: panel("sysdetail"),
    detail: { flex: at([...col, node("aside", ["detail"])], "flex"), minHeight: at([...col, node("aside", ["detail"])], "min-height") },
  };
}

describe("no panel rect overlaps the canvas rect", () => {
  for (const [width, height] of [[1280, 800], [1440, 900]] as const) {
    for (const sessions of [false, true]) {
      it(`${width}x${height}, Inspector + Usage + This machine open${sessions ? ", Sessions open" : ""}`, () => {
        const row = layout(width, { inspector: true, sessions });
        // The column is a box of its own, laid out as a flex column in the last track.
        expect(row.columnDisplay).toBe("flex");
        expect(row.columnFlow).toBe("column");
        expect(row.columnPosition).toBe("relative");
        expect(row.columnOverflow).toBe("hidden");
        expect(row.sideDisplay, "the panels are the column's own items").toBe("contents");
        for (const p of [row.usage, row.machine]) {
          expect(p.position, "in the column's flow, not fixed over the board").toBe("relative");
          expect(p.width, "the column's width, not a floating panel's").toBe("auto");
          expect(p.maxHeight).toBe("none");
        }
        // Every panel is inside the column, so its box is within the column's.
        expect(row.canvas.right).toBeGreaterThan(row.canvas.left);
        expect(overlaps(row.column, row.canvas), `${JSON.stringify(row.column)} against ${JSON.stringify(row.canvas)}`).toBe(false);
        expect(row.column.left).toBe(row.canvas.right);
        expect(row.column.right, "the column ends at the right stripe").toBe(width - row.edge);
        // The Inspector takes the rest of the column and keeps at least half.
        expect(row.detail.flex).toBe("1 1 0");
        expect(row.detail.minHeight).toBe("50%");
      });
    }
  }

  it("is the same column with no Inspector, so opening it does not move the canvas's edge", () => {
    for (const width of [1280, 1440]) {
      for (const sessions of [false, true]) {
        const alone = layout(width, { inspector: false, sessions });
        const beside = layout(width, { inspector: true, sessions });
        expect(alone.column, `${width}`).toEqual(beside.column);
        expect(alone.canvas, `${width}`).toEqual(beside.canvas);
        expect(overlaps(alone.column, alone.canvas)).toBe(false);
        expect(alone.usage.position).toBe("relative");
      }
    }
  });
});

describe("the fit uses the canvas that is left", () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

  it("finds nothing of a panel over the canvas once the panels are in the column", () => {
    const canvas = { getBoundingClientRect: () => ({ left: 40, right: 880 }) };
    const panels = [{ left: 881, width: 359 }, { left: 881, width: 359 }];
    (globalThis as Record<string, unknown>).document = {
      querySelectorAll: () => panels.map(p => ({ getBoundingClientRect: () => ({ left: p.left, width: p.width }) })),
    };
    expect(railCover(canvas as unknown as Element)).toBe(0);
  });

  it("measures the canvas box itself for every fit, with no second path", () => {
    const camera = code("use-camera.ts");
    expect(camera).toContain("const paneRect = boardRect(pane);");
    expect(camera).toContain("const railWidth = railCover(pane);");
  });
});

describe("App's wiring", () => {
  const app = code("App.tsx");

  it("draws the column on a desktop Board only, while it holds a part", () => {
    expect(app).toMatch(/const inRightCol = \(shown: boolean, phase: PanelPhase\) => \(shown \? isMounted\(phase\) : phase === "leaving"\);/);
    expect(app).toMatch(/const rightCol = !phone && !inWorkspace\s*&& \(detailShown \|\| inRightCol\(usageRail\.shown, usagePhase\) \|\| inRightCol\(machineRail\.shown, machinePhase\)\);/);
    expect(app).toContain('data-right-col={rightCol ? "" : undefined}');
  });

  it("holds Usage, This machine and then the Inspector, in that order, in one wrapper", () => {
    const start = app.indexOf('<div className="right-col">');
    expect(start).toBeGreaterThan(-1);
    const usage = app.indexOf("<UsagePanel", start);
    const machine = app.indexOf("<MachinePanel", start);
    const inspector = app.indexOf("{detailOnScreen ? (", start);
    const end = app.indexOf("</div>", inspector);
    expect(start).toBeLessThan(usage);
    expect(usage).toBeLessThan(machine);
    expect(machine).toBeLessThan(inspector);
    expect(app.slice(inspector, end)).toContain("<DetailAside");
  });

  it("finds the Inspector's phone sheet inside the wrapper", () => {
    expect(code("use-phone-sheets.ts")).toContain('inspector: ".app > .right-col > .detail:not(.leaving)",');
  });
});

describe("an opened panel's head in the column", () => {
  const board: PanelDock = { mode: "board", folded: false, fold() {}, unfold() {}, popOut() {}, dock() {} };
  const heads = (dock: PanelDock) => {
    const head = (html: string, cls: string) => html.slice(html.indexOf(`class="${cls}"`), html.indexOf("-body\""));
    return {
      machine: head(renderToStaticMarkup(createElement(MachinePanel, { usageOpen: false, onClose: () => {}, dock })), "sd-top"),
      usage: head(renderToStaticMarkup(createElement(UsagePanel, {
        state: initialState(), now: 0, providers: { ...ASSUMED, claude: false, codex: false }, onClose: () => {}, dock,
      })), "up-header"),
    };
  };
  const foldBack = /<h2 class="[^"]*fold-row"><button type="button" class="fold-head" aria-expanded="true" title="Fold">/;

  it("has the up chevron that folds it back while the Inspector is open, beside its close", () => {
    const { machine, usage } = heads({ ...board, refold: () => {} });
    expect(machine).toMatch(foldBack);
    expect(machine).toContain('id="sd-title"');
    expect(machine).toContain("sd-close");
    expect(usage).toMatch(foldBack);
    expect(usage).toContain("up-close");
  });

  it("has no chevron without the Inspector: the plain title and its close", () => {
    const { machine, usage } = heads(board);
    expect(machine).not.toContain("fold-head");
    expect(machine).toContain('<h2 class="sd-title" id="sd-title">');
    expect(machine).toContain("sd-close");
    expect(usage).not.toContain("fold-head");
    expect(usage).toContain("<h2>");
    expect(usage).toContain("up-close");
  });
});

describe("the phone", () => {
  it("keeps one track and no column box, even if the column were asked for", () => {
    const present = new Set(["right-col", "detail"]);
    const app = node("div", ["app"], { "data-right-col": "" });
    const page = [el("html", [], { states: ["root"], attrs: { "data-any": "" } }), node("body"), app];
    const at = (chain: El[], prop: string) => cascade(sel => weigh(sel, chain, present), prop, 390);
    expect(at(page, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(at([...page, node("div", ["right-col"])], "display")).toBe("contents");
  });
});
