// The folded Inspector keeps a tab in the pane header's band (V4's Figma and
// motion spec): the tab's presence by width, view and Zoom; ‹ and D; Escape in
// the sheet and in the pane; the stored Inspector flag left alone by the folded
// start; the pane header's padding; the glyphs; the sheet's motion and its
// reduced answer; and the new name in every catalog.
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { inspectorIsSheet, inspectorTabShown, type InspectorPlace } from "../inspector-corner";
import { focusAfterFold, INSPECTOR_TAB_BUTTON } from "../fold-focus";
import { pickSessionForInspector } from "../use-deck-shortcuts";
import InspectorTab from "../components/InspectorTab";
import { sheetText } from "./sheet-source";
import type { GraphState } from "../reducer";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const app = strip(read("App.tsx"));
const css = strip(sheetText());
const shortcuts = strip(read("use-deck-shortcuts.ts"));
const panels = strip(read("use-right-panels.ts"));

const BASE: InspectorPlace & { folded: boolean; shown: boolean } = {
  workspace: true, wide: true, column: false, zoom: false, folded: false, shown: false,
};
const tab = (over: Partial<typeof BASE>) => inspectorTabShown({ ...BASE, ...over });

describe("the tab's presence", () => {
  it("from 1320 shows only after a fold, and goes when the column is back", () => {
    expect(tab({ column: true, folded: false })).toBe(false);
    expect(tab({ column: true, folded: true })).toBe(true);
    expect(tab({ column: true, folded: true, shown: true })).toBe(false);
  });

  it("from 1100 to 1319 shows whenever the sheet is closed, and not while it is open", () => {
    expect(tab({ column: false, shown: false })).toBe(true);
    expect(tab({ column: false, shown: true })).toBe(false);
    expect(tab({ column: false, folded: true })).toBe(true);
  });

  it("is never drawn under 1100 or on a phone (neither is wide), on the Board, or under Zoom", () => {
    expect(tab({ wide: false })).toBe(false);
    expect(tab({ wide: false, column: true, folded: true })).toBe(false);
    expect(tab({ workspace: false })).toBe(false);
    expect(tab({ workspace: false, column: true, folded: true })).toBe(false);
    expect(tab({ zoom: true })).toBe(false);
    expect(tab({ zoom: true, column: true, folded: true })).toBe(false);
  });

  it("makes the sheet the Inspector only in Workspace, wide, and under 1320", () => {
    expect(inspectorIsSheet({ workspace: true, wide: true, column: false })).toBe(true);
    expect(inspectorIsSheet({ workspace: true, wide: true, column: true })).toBe(false);
    expect(inspectorIsSheet({ workspace: true, wide: false, column: false })).toBe(false);
    expect(inspectorIsSheet({ workspace: false, wide: true, column: false })).toBe(false);
  });

  it("is asked of the stage's gate, the 1100 line, the 1320 line and Zoom, in App", () => {
    expect(app).toMatch(/inspectorIsSheet\(\{ workspace: inWorkspace && stage\.enabled, wide: wideWindow, column: inspectorColumn \}\)/);
    expect(app).toMatch(/zoom: zoomPhase !== undefined \|\| stage\.expanded/);
    expect(app).toContain("{inspectorTab && <InspectorTab onShow={showInspector} />}");
    expect(app).toContain('data-insp-tab={inspectorTab ? "" : undefined}');
    // The Board's Fold gets no tab: the tab is only ever asked inside Workspace.
    expect(read("inspector-corner.ts")).toContain("!p.workspace");
  });

  it("is one button, ‹, named 'Show the Inspector' with D", () => {
    const out = renderToStaticMarkup(createElement(InspectorTab, { onShow: () => {} }));
    expect(out).toContain('class="insp-corner"');
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Show the Inspector"');
    expect(read("components/InspectorTab.tsx")).toContain('<KitIcon name="chevron-left" />');
    expect(read("components/InspectorTab.tsx")).toContain('keys: singleKeys ? "D" : undefined');
  });
});

describe("‹ and D", () => {
  it("‹ does what D does: opens with a selection, and with none picks the session D would pick", () => {
    const at = app.indexOf("const showInspector = useCallback(");
    const body = app.slice(at, app.indexOf("const sheetFoldRef", at));
    expect(body).toContain("setInspectorFolded(false)");
    expect(body).toContain("if (primarySelectedIdRef.current) setDetailOpen(true);");
    expect(body).toContain("else pickSessionForInspector(stateRef.current, focusSession, stepAgent);");
    expect(shortcuts).toContain("if (primarySelectedIdRef.current) setDetailOpen(o => !o);");
    expect(shortcuts).toContain("else pickSessionForInspector(stateRef.current, focusSession, stepAgent);");
  });

  it("picks the session that has waited longest, else steps on to the next card", () => {
    const focusSession = vi.fn();
    const stepAgent = vi.fn();
    pickSessionForInspector({ agents: new Map() } as unknown as GraphState, focusSession, stepAgent);
    expect(stepAgent).toHaveBeenCalledWith(1);
    expect(focusSession).not.toHaveBeenCalled();
    const waiting = (id: string, since: number) => [id, { id, kind: "root", label: id, waiting: { kind: "permission", since } }] as const;
    const state = { agents: new Map([waiting("late", 20), waiting("early", 10)]) } as unknown as GraphState;
    pickSessionForInspector(state, focusSession, stepAgent);
    expect(focusSession).toHaveBeenCalledWith("early");
  });
});

describe("the folded start does not touch the Board's choice", () => {
  it("holds the flag in memory, as the panels do, and never writes the hold as a close", () => {
    expect(panels).toContain("const detailHeldRef = useRef(false);");
    expect(panels).toMatch(/if \(detailOpen\) detailHeldRef\.current = false;\s*else if \(detailHeldRef\.current\) return;\s*saveDetailOpen\(detailOpen\);/);
    expect(panels).toContain("detail: () => { detailHeldRef.current = true; setDetailOpen(false); },");
  });

  it("asks for the hold when Workspace is entered at the sheet width, or the window narrows into it", () => {
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{ if \(inspectorSheet\) holdRight\.detail\(\); \}, \[inspectorSheet\]\);/);
  });
});

describe("Escape and the fold's focus", () => {
  it("in the sheet folds it, and the keys in the pane never reach that branch", () => {
    const esc = shortcuts.slice(shortcuts.indexOf('if (e.key === "Escape")'));
    expect(esc).toContain('inspectorSheetFoldRef?.current && el?.closest?.(".detail")');
    // The pane's keys return before Escape is read at all: the terminal's Escape is the agent's.
    expect(shortcuts.indexOf("if (inTerminalPanel(el))")).toBeLessThan(shortcuts.indexOf('if (e.key === "Escape")'));
    expect(shortcuts.slice(shortcuts.indexOf("if (inTerminalPanel(el))"), shortcuts.indexOf('if (e.key === "Escape")'))).toContain("return;");
    expect(app).toContain("useMirroredRef<(() => void) | null>(inspectorSheet && detailShown ? foldInspector : null)");
    expect(app).toContain("inspectorSheetFoldRef: sheetFoldRef");
  });

  it("goes to the pane, and to the tab's button when the pane takes nothing", () => {
    const tabEl = { focus() { root.activeElement = this; } };
    const root = {
      activeElement: null as unknown,
      querySelector: (s: string) => (s === INSPECTOR_TAB_BUTTON ? tabEl : null),
    } as { activeElement: unknown; querySelector(s: string): unknown };
    expect(focusAfterFold(root as never)).toBe(tabEl);
    expect(root.activeElement).toBe(tabEl);
    expect(INSPECTOR_TAB_BUTTON).toBe(".insp-corner button");
  });

  it("is also the hand-off when D or a deselect closes the sheet with the keys in it or on nothing", () => {
    expect(app).toContain("sheetWasShown.current = inspectorSheet && detailShown;");
    expect(app).toMatch(/at === document\.body \|\| at\.closest\("\.detail"\)\) focusAfterFold\(document\)/);
  });
});

describe("the layout", () => {
  const rule = (sel: string) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      if (m[1].split(",").map(s => s.replace(/\s+/g, " ").trim()).includes(sel)) return m[2].replace(/\s+/g, " ");
    }
    throw new Error(`no rule for ${sel}`);
  };

  it("draws the tab 36 wide in the header's band, on the panel surface, with its left and bottom lines only", () => {
    const body = rule(".insp-corner");
    expect(body).toContain("width: 36px");
    expect(body).toContain("height: var(--pane-head-h)");
    expect(body).toContain("top: calc(var(--topbar-h) + var(--rating-h, 0px))");
    expect(body).toContain("right: 0");
    expect(body).toContain("background: var(--panel)");
    expect(body).toContain("border-left: 1px solid var(--line)");
    expect(body).toContain("border-bottom: 1px solid var(--line)");
    expect(body).toContain("border-radius: 0");
    expect(body).not.toMatch(/border-(top|right):/);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("holds the button to the kit's 24 x 24, radius 6, with no fill", () => {
    const body = rule(".insp-corner .insp-show");
    expect(body).toContain("width: 24px");
    expect(body).toContain("height: 24px");
    expect(body).toContain("border-radius: var(--r-ctl)");
    expect(body).toContain("background: transparent");
  });

  it("ends the pane header 36 earlier while the tab shows: today's 6 and the tab's 36", () => {
    expect(rule('.app[data-view="workspace"][data-insp-tab] .stage-dock .ts-head')).toContain("padding-right: calc(6px + 36px)");
    expect(css).toContain("padding: 0 6px 0 12px");
  });

  it("is not under the sheet: the tab's layer is below the sheet's", () => {
    expect(rule(".insp-corner")).toContain("z-index: 19");
    expect(css).toMatch(/\.app\[data-view="workspace"\] \.detail \{[^}]*z-index: 20/);
  });
});

describe("the sheet's motion", () => {
  const sheet = css.slice(css.indexOf("@media (min-width: 1100px) and (max-width: 1319px) {"));
  const sel = '.app[data-view="workspace"]:not([data-zoom]) .detail';

  it("is a transition, not a keyframe: out on fold timing, in on unfold timing, on the panels' curve", () => {
    expect(sheet).toContain(`${sel}[data-sheet] {`);
    expect(sheet).toMatch(/\.detail\[data-sheet\] \{[^}]*transform var\(--dur-stage-out\) var\(--ease-stage\)/);
    expect(sheet).toMatch(/\.detail\[data-sheet="in"\] \{[^}]*transform var\(--dur-move\) var\(--ease-stage\)/);
    expect(sheet).toMatch(/\.detail:is\(\[data-sheet="pre"\], \[data-sheet="out"\]\) \{[^}]*transform: translateX\(100%\)/);
    expect(sheet.slice(0, sheet.indexOf("@media (min-width: 1100px) and (max-width: 1319px) and"))).not.toContain("@keyframes");
  });

  it("wears the overlay shadow, with no scrim or layer of its own", () => {
    expect(sheet).toMatch(/\.detail\[data-sheet\] \{[^}]*box-shadow: var\(--shadow-overlay\)/);
    expect(css).not.toMatch(/\.insp-scrim|\.detail-scrim/);
  });

  it("is at once by a key, and with reduced motion has no travel", () => {
    expect(sheet).toContain(`:root[data-motion="instant"] .app[data-view="workspace"]:not([data-zoom]) .detail[data-sheet] { transition: none; }`);
    const reduced = sheet.slice(sheet.indexOf("(prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("transition: none");
    expect(reduced).toMatch(/\.detail:is\(\[data-sheet="pre"\], \[data-sheet="out"\]\) \{ transform: none; \}/);
  });

  it("is held for its exit on the fold timing, and not at all by a key or under reduced motion", () => {
    expect(app).toContain('const sheetExitMs = inspectorSheet && !reducedMotion && !lastInputWasKey() ? tokenMs("--dur-stage-out") : 0;');
    expect(app).toContain("usePanelPresence(detailShown, phone ? railExitMs : sheetExitMs)");
    expect(app).toContain("(phone || sheetExitMs > 0) && isLeaving(detailShown, detailPhase)");
    expect(app).toContain("sheet={inspectorSheet}");
  });

  it("is drawn off the edge first and moved in after a style flush", () => {
    const aside = read("components/DetailAside.tsx");
    expect(aside).toContain("void asideRef.current?.offsetWidth;");
    expect(aside).toContain('const sheetState = !sheet ? undefined : leaving ? "out" : entered ? "in" : "pre";');
  });

  it("leaves Zoom's own rules alone: the sheet's rules do not match under data-zoom", () => {
    expect(sheet.match(/:not\(\[data-zoom\]\)/g)!.length).toBeGreaterThan(3);
  });
});

describe("the glyphs", () => {
  it("fold points right and unfold points left", () => {
    expect(read("components/Inspector.tsx")).toContain('<KitIcon name="chevron-right" />');
    expect(read("components/InspectorTab.tsx")).toContain('<KitIcon name="chevron-left" />');
  });
});

describe("the new name", () => {
  const dir = fileURLToPath(new URL("../i18n/areas/board/", import.meta.url));
  const langs = readdirSync(dir).filter(f => /^[a-zA-Z-]+\.ts$/.test(f) && f !== "index.ts");

  it("exists in all ten catalogs, written out and different from the English where the language is", () => {
    expect(langs.sort()).toEqual(["de.ts", "en.ts", "es.ts", "fr.ts", "ja.ts", "ko.ts", "pt-BR.ts", "ro.ts", "zh-CN.ts", "zh-TW.ts"]);
    const en = /"board\.inspector\.show": "([^"]+)"/.exec(readFileSync(dir + "en.ts", "utf8"))![1];
    expect(en).toBe("Show the Inspector");
    for (const f of langs) {
      const m = /"board\.inspector\.show": "([^"]+)"/.exec(readFileSync(dir + f, "utf8"));
      expect(m, f).not.toBeNull();
      if (f !== "en.ts") expect(m![1], f).not.toBe(en);
    }
  });
});
