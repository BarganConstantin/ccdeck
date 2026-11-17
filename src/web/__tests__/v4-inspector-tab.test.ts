// The folded Inspector (V4's Figma and motion spec): when the 320 sheet is the
// Inspector; the door that shows it and D; Escape in the sheet and in the pane;
// the stored Inspector flag left alone by the folded start; the sheet's motion
// and its reduced answer; and the new name in every catalog.
//
// CHANGED ON PURPOSE (V4's Figma): this file also pinned the folded
// Inspector's 36 x 36 corner tab, its glyph, its layout and the 36 it added to
// the pane header's right padding. V4's Figma replaces the tab with the
// Inspector's door, first on the right stripe, so the tab's tests are gone
// (v4-two-stripes.test.ts pins that it is, and the door's own behaviour); what
// is left is every fold path, which did not change.
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectorIsSheet } from "../inspector-corner";
import { focusAfterFold, INSPECTOR_DOOR_BUTTON } from "../fold-focus";
import { pickSessionForInspector } from "../use-deck-shortcuts";
import { sheetText } from "./sheet-source";
import type { GraphState } from "../reducer";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const app = strip(read("App.tsx"));
const css = strip(sheetText());
const shortcuts = strip(read("use-deck-shortcuts.ts"));
const panels = strip(read("use-right-panels.ts"));

describe("the sheet", () => {
  it("makes the sheet the Inspector only in Workspace, wide, and under 1320", () => {
    expect(inspectorIsSheet({ workspace: true, wide: true, column: false })).toBe(true);
    expect(inspectorIsSheet({ workspace: true, wide: true, column: true })).toBe(false);
    expect(inspectorIsSheet({ workspace: true, wide: false, column: false })).toBe(false);
    expect(inspectorIsSheet({ workspace: false, wide: true, column: false })).toBe(false);
  });

  it("is asked of the stage's gate, the 1100 line and the 1320 line, in App", () => {
    expect(app).toMatch(/inspectorIsSheet\(\{ workspace: inWorkspace && stage\.enabled, wide: wideWindow, column: inspectorColumn \}\)/);
    // The sheet is only ever asked inside Workspace; the Board's detail panel is not it.
    expect(read("inspector-corner.ts")).toContain("p.workspace");
  });
});

describe("the Inspector's door and D", () => {
  it("the door's unfold does what D does: opens with a selection, and with none picks the session D would pick", () => {
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

  // CHANGED ON PURPOSE (V4's Figma): the keyboard goes to the Inspector's door
  // on the right stripe where it went to the corner tab's button.
  it("goes to the pane, and to the Inspector's door when the pane takes nothing", () => {
    const doorEl = { focus() { root.activeElement = this; } };
    const root = {
      activeElement: null as unknown,
      querySelector: (s: string) => (s === INSPECTOR_DOOR_BUTTON ? doorEl : null),
    } as { activeElement: unknown; querySelector(s: string): unknown };
    expect(focusAfterFold(root as never)).toBe(doorEl);
    expect(root.activeElement).toBe(doorEl);
    expect(INSPECTOR_DOOR_BUTTON).toBe('button[data-rail-item="inspector"]');
  });

  it("is also the hand-off when D or a deselect closes the sheet with the keys in it or on nothing", () => {
    expect(app).toContain("sheetWasShown.current = inspectorSheet && detailShown;");
    expect(app).toMatch(/at === document\.body \|\| at\.closest\("\.detail"\)\) focusAfterFold\(document\)/);
  });
});

describe("the layout", () => {
  it("keeps the sheet above the stripe it stands clear of", () => {
    expect(css).toMatch(/\.app\[data-view="workspace"\] \.detail \{[^}]*z-index: 20/);
    expect(css).toMatch(/\.app\[data-view="workspace"\] \.detail \{[^}]*right: var\(--edge-w\)/);
  });
});

describe("the sheet's motion", () => {
  const sheet = css.slice(css.indexOf("@media (min-width: 1100px) and (max-width: 1319px) {"));
  const sel = '.app[data-view="workspace"]:not([data-zoom]) .detail';

  it("is a transition, not a keyframe: out on fold timing, in on unfold timing, on the panels' curve", () => {
    expect(sheet).toContain(`${sel}[data-sheet] {`);
    expect(sheet).toMatch(/\.detail\[data-sheet\] \{[^}]*transform var\(--dur-stage-out\) var\(--ease-stage\)/);
    expect(sheet).toMatch(/\.detail\[data-sheet="in"\] \{[^}]*transform var\(--dur-move\) var\(--ease-stage\)/);
    expect(sheet).toMatch(/\.detail:is\(\[data-sheet="pre"\], \[data-sheet="out"\]\) \{[^}]*transform: translateX\(calc\(100% \+ var\(--edge-w\)\)\)/);  // CHANGED ON PURPOSE (V4's Figma): off the window's edge, past the stripe the sheet stands clear of
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
  it("the fold points right, and the door that unfolds it is the kit's info icon", () => {
    expect(read("components/Inspector.tsx")).toContain('<KitIcon name="chevron-right" />');
    expect(read("components/rail-glyphs.tsx")).toContain('export const InspectorGlyph = () => <KitIcon name="info" className="glyph" />;');
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
