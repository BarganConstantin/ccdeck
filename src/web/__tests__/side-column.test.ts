// Workspace's side column (owner, 2026-11-08): Usage and This machine dock in
// one column beside the pane; the first opens it at 320, the second shares it
// at the split; the edge drags its width (280 to 420) and the split its share
// (each part at least 120); a part folds to its header or pops out to float
// over the view; what the reader set is kept per browser. On the Board the two
// float as before.
//
// The layout is a pure function and run as a table; the hook and the column's
// separators run under fake-react, the panels' header buttons the same way;
// App's wiring (the Inspector held under 1320) is read from its source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { all, mount, one } = await import("./fake-react");
const {
  KEY_STEP, ONE_PART_BELOW, PART_MIN, SIDE_KEY, SIDE_START, SIDE_W, SPLIT_H,
  clampWidth, layoutOf, parseSide, splitFor, useSideColumn,
} = await import("../side-column");
const { default: SideColumn, DockButtons } = await import("../components/SideColumn");
type El = import("./fake-react").Drawn;
type SideState = import("../side-column").SideState;
type PanelDock = import("../side-column").PanelDock;

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    dispatchEvent() { return true; },
    addEventListener() {},
    removeEventListener() {},
  };
});
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

const both = { usage: true, machine: true };
const none = { usage: false, machine: false };
const state = (patch: Partial<SideState> = {}): SideState => ({ ...SIDE_START, ...patch });

describe("the numbers", () => {
  it("starts at 320 and drags 280 to 420; the split is 8 and a part keeps 120; one part under 1024", () => {
    expect(SIDE_W).toEqual({ start: 320, min: 280, max: 420 });
    expect(SIDE_START.width).toBe(320);
    expect(SIDE_START.split).toBe(0.5);
    expect(SPLIT_H).toBe(8);
    expect(KEY_STEP).toBe(8);
    expect(PART_MIN).toBe(120);
    expect(ONE_PART_BELOW).toBe(1024);
    expect(SIDE_KEY).toBe("agent-dag.workspaceSide");
  });

  it("keeps a width inside its range, in whole pixels", () => {
    expect(clampWidth(200)).toBe(280);
    expect(clampWidth(500)).toBe(420);
    expect(clampWidth(333.4)).toBe(333);
  });

  it("keeps each part at least 120 high at the split, and an even share when two cannot fit", () => {
    expect(splitFor(300, 600)).toBe(0.5);
    expect(splitFor(10, 600)).toBe(0.2);
    expect(splitFor(590, 600)).toBe(0.8);
    expect(splitFor(150, 200)).toBe(0.5);
    expect(splitFor(150, Number.NaN)).toBe(0.5);
  });

  it("reads a stored column, and the start for a missing, broken or out-of-range one", () => {
    expect(parseSide(null)).toBe(SIDE_START);
    expect(parseSide("{not json")).toBe(SIDE_START);
    expect(parseSide(JSON.stringify({ width: 900, split: 2, fold: { usage: true }, float: { machine: "yes" } })))
      .toEqual({ width: 420, split: 0.5, fold: { usage: true, machine: false }, float: { usage: false, machine: false } });
    expect(parseSide(JSON.stringify({ width: 360, split: 0.3, fold: {}, float: { usage: true } })))
      .toEqual({ width: 360, split: 0.3, fold: { usage: false, machine: false }, float: { usage: true, machine: false } });
  });
});

describe("the layout", () => {
  const at = (p: Partial<Parameters<typeof layoutOf>[0]>) => layoutOf({
    workspace: true, mounted: both, state: state(), narrow: false, last: "usage", ...p,
  });

  it("is the Board's on the Board: no column, nothing docked or folded", () => {
    const l = at({ workspace: false, state: state({ fold: { usage: true, machine: true } }) });
    expect(l.on).toBe(false);
    expect(l.mode).toEqual({ usage: "board", machine: "board" });
    expect(l.folded).toEqual(none);
    expect(l.split).toBe(false);
  });

  it("opens the column with the first panel and shares it with the second", () => {
    expect(at({ mounted: none }).on).toBe(false);
    const one = at({ mounted: { usage: false, machine: true } });
    expect(one.on).toBe(true);
    expect(one.mode.machine).toBe("docked");
    expect(one.split).toBe(false);
    const two = at({});
    expect(two.on).toBe(true);
    expect(two.split).toBe(true);
  });

  it("takes a popped-out part out of the column, and the column away when none is docked", () => {
    const l = at({ state: state({ float: { usage: true, machine: false }, fold: { usage: true, machine: false } }) });
    expect(l.mode).toEqual({ usage: "float", machine: "docked" });
    expect(l.on).toBe(true);
    expect(l.split).toBe(false);
    expect(l.folded.usage, "a floating panel is never folded").toBe(false);
    expect(at({ state: state({ float: both }) }).on).toBe(false);
  });

  it("folds a part to its header, and the split goes with it", () => {
    const l = at({ state: state({ fold: { usage: true, machine: false } }) });
    expect(l.folded).toEqual({ usage: true, machine: false });
    expect(l.split).toBe(false);
  });

  it("under 1024 keeps one part open, the one used last, without rewriting what is stored", () => {
    expect(at({ narrow: true, last: "machine" }).folded).toEqual({ usage: true, machine: false });
    expect(at({ narrow: true, last: "usage" }).folded).toEqual({ usage: false, machine: true });
    expect(at({ narrow: true, last: "usage" }).split).toBe(false);
    // A stored fold already leaves one open.
    expect(at({ narrow: true, last: "usage", state: state({ fold: { usage: true, machine: false } }) }).folded).toEqual({ usage: true, machine: false });
    // One part alone is open whatever the width.
    expect(at({ narrow: true, mounted: { usage: true, machine: false } }).folded).toEqual(none);
  });
});

describe("the column's state", () => {
  type P = Parameters<typeof useSideColumn>[0];
  let out: ReturnType<typeof useSideColumn>;
  function Probe(p: P) { out = useSideColumn(p); return null; }
  const props = (patch: Partial<P> = {}): P => ({ workspace: true, open: both, mounted: both, narrow: false, ...patch });
  const stored = () => JSON.parse(store.get(SIDE_KEY) ?? "null") as SideState | null;

  it("starts at 320, even, nothing folded or floating, and writes nothing until the reader changes it", () => {
    mount(Probe, props());
    expect(out.width).toBe(320);
    expect(out.share).toBe(0.5);
    expect(out.on).toBe(true);
    expect(out.split).toBe(true);
    expect(store.has(SIDE_KEY)).toBe(false);
  });

  it("keeps the width, the split and the fold per browser, and reads them back on the next load", () => {
    mount(Probe, props());
    out.setWidth(512);
    expect(out.width).toBe(420);
    out.setShare(0.3);
    out.dock.machine.fold();
    expect(stored()).toEqual({ width: 420, split: 0.3, fold: { usage: false, machine: true }, float: none });
    mount(Probe, props());
    expect(out.width).toBe(420);
    expect(out.share).toBe(0.3);
    expect(out.folded.machine).toBe(true);
    expect(out.dock.machine.folded).toBe(true);
    out.dock.machine.unfold();
    expect(stored()?.fold.machine).toBe(false);
  });

  it("pops a part out and docks it back, and a reload in Workspace keeps it floating", () => {
    mount(Probe, props());
    out.dock.usage.popOut();
    expect(out.mode.usage).toBe("float");
    expect(out.dock.usage.mode).toBe("float");
    expect(out.split).toBe(false);
    mount(Probe, props());
    expect(out.mode.usage).toBe("float");
    out.dock.usage.dock();
    expect(out.mode.usage).toBe("docked");
    expect(stored()?.float.usage).toBe(false);
  });

  it("docks what is open when the view switches to Workspace: a panel opened on the Board docks here", () => {
    store.set(SIDE_KEY, JSON.stringify({ ...SIDE_START, float: { usage: true, machine: true } }));
    const m = mount(Probe, props({ workspace: false }));
    expect(out.mode).toEqual({ usage: "board", machine: "board" });
    m.rerender(props({ workspace: true }));
    expect(out.mode).toEqual({ usage: "docked", machine: "docked" });
    expect(stored()?.float).toEqual(none);
  });

  it("under 1024 opens the part used last, the other folded", () => {
    const m = mount(Probe, props({ open: { usage: true, machine: false }, mounted: { usage: true, machine: false }, narrow: true }));
    m.rerender(props({ narrow: true }));
    expect(out.folded).toEqual({ usage: true, machine: false });
    out.dock.usage.unfold();
    expect(out.folded).toEqual({ usage: false, machine: true });
    expect(stored(), "nothing stored: a wider window shows both again").toBeNull();
    m.rerender(props({ narrow: false }));
    expect(out.folded).toEqual(none);
  });
});

describe("the column", () => {
  const drawn = (p: Partial<Parameters<typeof SideColumn>[0]> = {}, height = 608) => {
    const calls = { width: [] as number[], share: [] as number[] };
    const m = mount(SideColumn, {
      on: true, split: true, width: 320, share: 0.5,
      onWidth: (w: number) => calls.width.push(w), onShare: (s: number) => calls.share.push(s),
      children: [{ type: "aside", props: { id: "usage-panel" } }, { type: "aside", props: { id: "system-panel" } }] as never,
      ...p,
    }, {
      // What the document does: the column's ref is its element, this tall.
      commit: tree => {
        const col = one(tree, el => el.props.className === "ws-side") as (El & { ref?: { current: unknown } }) | null;
        if (col?.ref && typeof col.ref === "object") col.ref.current = { clientHeight: height, getBoundingClientRect: () => ({ top: 40, width: 320 }) };
      },
    });
    const sep = (cls: string) => one(m.tree, el => el.props.className === cls);
    return { m, calls, sep };
  };
  const key = (el: El | null, k: string) => (el!.props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault() {} });

  it("is drawn around both panels, the split between them, the edge last", () => {
    const { m } = drawn();
    const col = one(m.tree, el => el.props.className === "ws-side")!;
    expect(col.props["data-on"]).toBe("");
    expect(col.props["data-split"]).toBe("");
    expect((col.props.style as Record<string, string>).width).toBe("320px");
    expect((col.props.style as Record<string, string>)["--split"]).toBe("0.5");
    const kids = (col.props.children as unknown[]).filter(Boolean) as El[];
    expect(kids.map(k => (k.props.id as string) ?? k.props.className)).toEqual(["usage-panel", "ws-split", "system-panel", "ws-edge"]);
  });

  it("is no box with nothing docked: no split, no edge", () => {
    const { m, sep } = drawn({ on: false, split: false });
    const col = one(m.tree, el => el.props.className === "ws-side")!;
    expect(col.props["data-on"]).toBeUndefined();
    expect(sep("ws-split")).toBeNull();
    expect(sep("ws-edge")).toBeNull();
  });

  it("names its edge and its split as separators a keyboard can reach, with the values they stand at", () => {
    const { sep } = drawn();
    const edge = sep("ws-edge")!;
    expect(edge.props.role).toBe("separator");
    expect(edge.props.tabIndex).toBe(0);
    expect(edge.props["aria-orientation"]).toBe("vertical");
    expect([edge.props["aria-valuemin"], edge.props["aria-valuemax"], edge.props["aria-valuenow"]]).toEqual([280, 420, 320]);
    expect(edge.props["aria-label"]).toBe("Side column width");
    const split = sep("ws-split")!;
    expect(split.props.role).toBe("separator");
    expect(split.props.tabIndex).toBe(0);
    expect(split.props["aria-orientation"]).toBe("horizontal");
    expect(split.props["aria-valuenow"]).toBe(50);
  });

  it("moves the edge 8 px a key: left widens, right narrows, Home and End to the range's ends", () => {
    const { calls, sep } = drawn();
    key(sep("ws-edge"), "ArrowLeft");
    key(sep("ws-edge"), "ArrowRight");
    key(sep("ws-edge"), "Home");
    key(sep("ws-edge"), "End");
    key(sep("ws-edge"), "a");
    expect(calls.width).toEqual([328, 312, 280, 420]);
    const wide = drawn({ width: 416 });
    key(wide.sep("ws-edge"), "ArrowLeft");
    expect(wide.calls.width).toEqual([420]);
  });

  it("moves the split 8 px a key, each part kept at least 120", () => {
    // 608 high: 600 between the parts, Usage's half at 300.
    const { calls, sep } = drawn();
    key(sep("ws-split"), "ArrowUp");
    key(sep("ws-split"), "ArrowDown");
    expect(calls.share).toEqual([splitFor(292, 600), splitFor(308, 600)]);
    const low = drawn({ share: 0.2 });
    key(low.sep("ws-split"), "ArrowUp");
    expect(low.calls.share).toEqual([0.2]);
  });
});

describe("a part's header buttons", () => {
  const dock = (mode: PanelDock["mode"], folded = false): PanelDock & { pressed: string[] } => {
    const pressed: string[] = [];
    return {
      mode, folded, pressed,
      fold: () => pressed.push("fold"), unfold: () => pressed.push("unfold"),
      popOut: () => pressed.push("popOut"), dock: () => pressed.push("dock"),
    };
  };
  const buttons = (d: PanelDock | undefined, popOut = () => {}) => {
    const m = mount(DockButtons, { dock: d, popOut });
    return all(m.tree, el => el.type === "button");
  };

  it("draws nothing on the Board, where a panel has its close alone", () => {
    expect(buttons(undefined)).toEqual([]);
    expect(buttons(dock("board"))).toEqual([]);
  });

  it("docked: Fold and Pop out, named buttons; folded, the chevron unfolds", () => {
    const d = dock("docked");
    let popped = 0;
    const b = buttons(d, () => { popped++; });
    expect(b.map(x => x.props["aria-label"])).toEqual(["Fold", "Pop out"]);
    expect(b.map(x => x.props.title)).toEqual(["Fold", "Pop out"]);
    (b[0].props.onClick as () => void)();
    (b[1].props.onClick as () => void)();
    expect(d.pressed).toEqual(["fold"]);
    expect(popped, "Pop out goes through the panel, which gives it its first place").toBe(1);
    const f = dock("docked", true);
    const folded = buttons(f);
    expect(folded[0].props["aria-label"]).toBe("Unfold");
    (folded[0].props.onClick as () => void)();
    expect(f.pressed).toEqual(["unfold"]);
  });

  it("popped out: the one button that docks it back", () => {
    const d = dock("float");
    const b = buttons(d);
    expect(b.map(x => x.props["aria-label"])).toEqual(["Dock in the column"]);
    (b[0].props.onClick as () => void)();
    expect(d.pressed).toEqual(["dock"]);
  });

  it("are in both panels' headers, before the close, and a folded part keeps a live line", () => {
    const usage = code("components/UsagePanel.tsx");
    // CHANGED ON PURPOSE (owner 2026-11-10): no board headline; chips from first paint; logs-unread sentence.
    // The folded line carries the logs' figure only: before ccusage answered it
    // printed the board's sum beside the period word.
    // CHANGED ON PURPOSE (critique 3 review): the plain title is the branch for
    // a panel with no fold-back (inspector-fold.test.ts), so a `}` may close it.
    expect(usage).toMatch(/<h2>\{t\("usage\.title"\)\}<\/h2>\}?(?:\s|\{\})*\{dock\?\.folded && fromRange && <span className="side-sum">/);
    expect(usage).toMatch(/<DockButtons dock=\{dock\} popOut=\{place\.popOut\} \/>[\s\S]{0,200}?up-close/);
    const machine = code("components/MachinePanel.tsx");
    expect(machine).toMatch(/<h2 className="sd-title" id="sd-title">[^<]*<\/h2>\}?(?:\s|\{\})*\{dock\?\.folded && summary && <span className="side-sum">\{summary\}<\/span>\}\s*<DockButtons dock=\{dock\} popOut=\{place\.popOut\} \/>\s*<button type="button" className="glyph-btn sd-close"/);
  });
});

describe("App's wiring", () => {
  const app = code("App.tsx");

  it("docks in Workspace off a phone, from both panels' open flags, one part under 1024", () => {
    expect(app).toContain('const ONE_PART_QUERY = "(max-width: 1023px)";');
    expect(app).toMatch(/useSideColumn\(\{\s*workspace: inWorkspace && !phone,\s*open: \{ usage: usagePanelOpen, machine: machinePanelOpen \},\s*mounted: \{ usage: isMounted\(usagePhase\), machine: isMounted\(machinePhase\) \},\s*narrow: onePart,\s*\}\)/);
    expect(app).toContain('data-side={side.on ? "" : undefined}');
    // A load in Workspace opens both as they were left: they share the column,
    // so the Board's side-by-side room rule does not hold This machine.
    expect(app).toContain('useRightPanels(leftColumnWidth(leftPanel, railWidth), readView() === "workspace")');
    // CHANGED ON PURPOSE (owner, 2026-11-11 critique): each dock goes through
    // withInspectorFold, which hands Workspace's on as it is and carries the
    // Inspector's fold on the Board (inspector-fold.test.ts).
    expect(app).toMatch(/usage: withInspectorFold\(side\.dock\.usage,[\s\S]*?machine: withInspectorFold\(side\.dock\.machine,/);
    expect(app).toMatch(/<SideColumn on=\{side\.on\} split=\{side\.split\} width=\{side\.width\} share=\{side\.share\} onWidth=\{side\.setWidth\} onShare=\{side\.setShare\}>[\s\S]*?dock=\{docks\.usage\}[\s\S]*?dock=\{docks\.machine\}[\s\S]*?<\/SideColumn>/);
  });

  it("under 1320 the column takes the Inspector's place, and closing both brings the Inspector back", () => {
    const at = app.indexOf("const sideTookInspector = useRef(false);");
    expect(at).toBeGreaterThan(-1);
    const effect = app.slice(at, app.indexOf("}, [side.on, inWorkspace, inspectorColumn]);", at));
    expect(effect).toContain("if (!inWorkspace || inspectorColumn) { sideTookInspector.current = false; return; }");
    expect(effect).toMatch(/if \(side\.on && detailShown\) \{\s*sideTookInspector\.current = true;\s*holdRight\.detail\(\);/);
    expect(effect).toMatch(/else if \(!side\.on && sideTookInspector\.current\) \{\s*sideTookInspector\.current = false;\s*if \(primarySelectedIdRef\.current\) setDetailOpen\(true\);/);
  });
});

describe("the strings", () => {
  const LANGS = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
  const KEYS = ["fold", "unfold", "popOut", "dock", "dragToDock", "split", "splitHint", "width", "widthHint", "usageSum", "usageTokens", "machineSum"];

  it("are in all ten languages, with the same placeholders as English", () => {
    const en = read("i18n/areas/shell/en.ts");
    const holes = (text: string, k: string) => {
      const m = new RegExp(`"shell\\.side\\.${k}": "([^"]*)"`).exec(text);
      expect(m, k).not.toBeNull();
      return [...m![1].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
    };
    for (const lang of LANGS) {
      const text = read(`i18n/areas/shell/${lang}.ts`);
      for (const k of KEYS) expect(holes(text, k), `${lang} ${k}`).toEqual(holes(en, k));
    }
  });
});

describe("the Board and the phone", () => {
  const flat = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

  // CHANGED ON PURPOSE (critique 3): on the Board the panels are parts of the
  // right column, which panel-place.css draws; this wrapper stays no box there.
  it("the wrapper is no box on the Board, where the right column holds the panels", () => {
    expect(flat("styles/panel-place.css")).toContain(".ws-side { display: contents; }");
    // Every other rule of the column is Workspace's.
    const ws = flat("styles/workspace.css");
    for (const m of ws.matchAll(/([^{}]*\.(?:ws-side|ws-split|ws-edge|side-sum|side-btn)[^{}]*)\{/g)) {
      // Split at the list's own commas, not those inside :has() or :is().
      const list: string[] = [];
      let depth = 0, from = 0;
      for (let i = 0; i < m[1].length; i++) {
        const c = m[1][i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) { list.push(m[1].slice(from, i)); from = i + 1; }
      }
      list.push(m[1].slice(from));
      for (const sel of list) expect(sel.trim(), sel).toMatch(/\[data-view="workspace"\]|:root\[data-view-switch\]/);
    }
  });

  it("on a phone Usage and This machine are full-height sheets, one at a time, with no grip", () => {
    const phone = flat("styles/phone-sheet.css");
    expect(phone).toContain(".app.app.app .usage-panel, .app.app.app .sysdetail { height: var(--sheet-room); max-height: var(--sheet-room); }");
    // CHANGED ON PURPOSE (critique 3): only a part popped out of Workspace's column has a grip.
    expect(code("panel-place.ts")).toContain('const grip = phone || mode !== "float" ? {} : {');
  });
});

