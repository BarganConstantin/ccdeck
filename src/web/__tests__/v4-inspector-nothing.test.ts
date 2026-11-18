// The Inspector with no session to show (the owner's call, 2026-11-18). On a
// first run's empty board the Inspector's door and D did nothing at all, and a
// new user pressed them again. Both open the Inspector now, on one muted line,
// "Choose a session to see its details.", and nothing else; the door reads
// Open while it shows; the door, D and Escape close it; a selected session
// still shows as it did, and with sessions on the board D and the door still
// pick one.
//
// D is the deck's one keydown handler, run through deck-keys-harness.ts (the
// mock runs its effect at once). The line is rendered. App's wiring, which
// needs the whole deck, is read as text, the way the Inspector's other tests
// read it; the browser check drives the real thing.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { readFileSync, readdirSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { mountDeckKeys } = await import("./deck-keys-harness");
const { EmptyInspector, NOTHING_INSPECTOR_LINE_MSG } = await import("../components/Inspector");
const { INSPECTOR_REGION_ID, inspectorDoorOpen, inspectorDoorPress } = await import("../inspector-corner");
const { sheetRules } = await import("./sheet-cascade");

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const code = (p: string) => readFileSync(here(p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const app = code("../App.tsx");

afterEach(() => { vi.unstubAllGlobals(); });

describe("D with nothing selected", () => {
  it("presses the Inspector's door when there is no session to pick (a first run's empty board)", () => {
    const door = vi.fn();
    const deck = mountDeckKeys({ selected: null, cards: false, inspectorDoor: door });
    deck.press("d");
    expect(deck.props.stepAgent).toHaveBeenCalledWith(1);
    expect(door).toHaveBeenCalledTimes(1);
    expect(deck.props.focusSession).not.toHaveBeenCalled();
    expect(deck.detail.set).not.toHaveBeenCalled();
    // The door is the toggle: the second D is its second press, which closes.
    deck.press("D");
    expect(door).toHaveBeenCalledTimes(2);
  });

  it("still picks a session when the board has one, and leaves the door alone", () => {
    const door = vi.fn();
    const deck = mountDeckKeys({ selected: null, cards: true, inspectorDoor: door });
    deck.press("d");
    expect(deck.props.stepAgent).toHaveBeenCalledWith(1);
    expect(door).not.toHaveBeenCalled();
  });

  it("with a session selected still toggles that session's Inspector, as before", () => {
    const door = vi.fn();
    const deck = mountDeckKeys({ selected: "s1", cards: false, inspectorDoor: door });
    deck.press("d");
    expect(deck.detail.value).toBe(true);
    deck.press("d");
    expect(deck.detail.value).toBe(false);
    expect(door).not.toHaveBeenCalled();
    expect(deck.props.stepAgent).not.toHaveBeenCalled();
  });

  it("does nothing more than before on a deck mounted without the door", () => {
    const deck = mountDeckKeys({ selected: null, cards: false });
    expect(() => deck.press("d")).not.toThrow();
    expect(deck.detail.set).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("is the deck's clear, which App gives the Inspector on nothing too", () => {
    const deck = mountDeckKeys({ selected: null, cards: false, inspectorDoor: vi.fn() });
    deck.press("Escape");
    expect(deck.props.clearSelection).toHaveBeenCalledTimes(1);
    expect(app).toContain("const clearInspection = useCallback(() => { clearSelection(); setInspectingNothing(false); }, [clearSelection]);");
    expect(app).toContain("clearSelection: clearInspection, selectAgent, focusAgent, stepAgent,");
  });

  it("in Workspace's sheet folds it, which closes the panel and the line with it", () => {
    expect(app).toContain("useMirroredRef<(() => void) | null>(inspectorSheet && detailShown ? foldInspector : null)");
    expect(app).toMatch(/if \(!detailOpen \|\| primarySelectedId \|\| \(inWorkspace && inspectorColumn\)\) setInspectingNothing\(false\);/);
  });
});

describe("the door", () => {
  const toggle = (): string => {
    const at = app.indexOf("const toggleInspector = useCallback(");
    return app.slice(at, app.indexOf("}, [", at));
  };

  it("on the Board and under 1100 is D's press: with nothing to pick it opens the Inspector on its line, and closes it again", () => {
    expect(inspectorDoorPress({ workspace: false, column: false, sheet: false, open: false })).toBe("d");
    expect(inspectorDoorPress({ workspace: false, column: false, sheet: false, open: true })).toBe("d");
    const body = toggle();
    const selected = body.indexOf("else if (primarySelectedIdRef.current) setDetailOpen(o => !o);");
    const close = body.indexOf("else if (inspectorOpen) setInspectingNothing(false);");
    const open = body.indexOf("else if (!pickSessionForInspector(stateRef.current, focusSession, stepAgent)) inspectNothing();");
    // A selection first, as before; then the close; then the pick, and the line only when it found nothing.
    expect(selected).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(selected);
    expect(open).toBeGreaterThan(close);
    expect(app).toContain("const inspectNothing = useCallback(() => { setInspectingNothing(true); setDetailOpen(true); }, [setDetailOpen]);");
  });

  // CHANGED ON PURPOSE (owner 2026-11-18): the column draws the same Inspector, its one line
  // included (below, "what it draws"); the door still never asks for it there.
  it("in Workspace's sheet (1100 to 1319) opens it on the line; the column (1320 up) draws it by itself", () => {
    expect(inspectorDoorPress({ workspace: true, column: false, sheet: true, open: false })).toBe("show");
    const at = app.indexOf("const showInspector = useCallback(");
    const body = app.slice(at, app.indexOf("}, [", at));
    expect(body).toContain("else if (!pickSessionForInspector(stateRef.current, focusSession, stepAgent) && inspectorSheet) inspectNothing();");
    expect(app).toMatch(/\) : <EmptyInspector \/>\s*\) : null\}/);
  });

  it("reads Open while the line shows: it is the panel the door reports", () => {
    expect(app).toMatch(/const detailWanted = detailOpen && \(selected != null \|\| inspectingNothing\);/);
    expect(app).toContain("workspace: inWorkspace, column: inspectorColumn, folded: inspectorFolded, shown: detailShown, zoomed,");
    // The Board, Workspace under 1100, and the sheet.
    expect(inspectorDoorOpen({ workspace: false, column: false, folded: false, shown: true, zoomed: false })).toBe(true);
    expect(inspectorDoorOpen({ workspace: true, column: false, folded: false, shown: true, zoomed: false })).toBe(true);
    // Closed again, it reads closed.
    expect(inspectorDoorOpen({ workspace: false, column: false, folded: false, shown: false, zoomed: false })).toBe(false);
  });

  it("is what D presses: the same function, read through a ref", () => {
    expect(app).toContain("const inspectorDoorRef = useMirroredRef<(() => void) | null>(toggleInspector);");
    expect(app).toContain("inspectorSheetFoldRef: sheetFoldRef, inspectorDoorRef,");
  });
});

describe("what it draws", () => {
  // CHANGED ON PURPOSE (owner 2026-11-18): no `nothing` prop any more. The one line is
  // all EmptyInspector ever says, Workspace's column included.
  const nothing = renderToStaticMarkup(createElement(EmptyInspector));

  it("is the Inspector's own region, which the door controls", () => {
    expect(nothing).toMatch(new RegExp(`^<aside id="${INSPECTOR_REGION_ID}" class="detail"`));
    expect(nothing).toContain('aria-label="Detail"');
  });

  it("says one muted line, and nothing else: no title, no button, no second line", () => {
    expect(NOTHING_INSPECTOR_LINE_MSG).toBe("board.inspector.chooseSession");
    const body = /<div class="insp-b insp-none">([\s\S]*?)<\/div>/.exec(nothing)?.[1];
    expect(body).toBe('<p class="insp-note">Choose a session to see its details.</p>');
    expect(nothing).not.toContain("<button");
    expect(nothing).not.toContain("insp-none-title");
    expect(nothing).not.toContain("<svg class=\"hero");
  });

  it("reuses the hint line's muted text and the empty Inspector's centring: no new colour, size or font", () => {
    const rules = sheetRules();
    const decl = (selector: string, prop: string) => {
      let found: string | undefined;
      for (const r of rules) {
        if (r.media !== null || !r.selectors.includes(selector)) continue;
        const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
        if (m) found = m[1].trim();
      }
      return found;
    };
    expect(decl(".insp-note", "color")).toBe("var(--muted)");
    expect(decl(".insp-note", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".insp-none", "justify-content")).toBe("center");
  });

  it("comes and goes as DetailAside does: leaving on the way out, and the sheet's entry in Workspace", () => {
    const leaving = renderToStaticMarkup(createElement(EmptyInspector, { leaving: true }));
    expect(leaving).toContain('class="detail leaving"');
    // Drawn off the edge first; the layout effect moves it in, which a static render never runs.
    const sheet = renderToStaticMarkup(createElement(EmptyInspector, { sheet: true }));
    expect(sheet).toContain('data-sheet="pre"');
    expect(nothing).not.toContain("data-sheet");
  });

  // CHANGED ON PURPOSE (owner 2026-11-18): Workspace's column (1320 up) said two lines of
  // its own, "No session in focus" over "Open one from the list.". It now says the one
  // line the Board, the sheet and the phone say, so the deck says the same at every width.
  it("is what Workspace's column says with no session in focus: exactly the one line", () => {
    const at = app.indexOf("{inWorkspace && inspectorColumn && !inspectorFolded && !(detailOpen && selected) ? (");
    expect(at).toBeGreaterThan(-1);
    const slot = app.slice(at, app.indexOf("{detailOnScreen ? (", at));
    // A session in focus: its Inspector. None: EmptyInspector as it is, with nothing to change what it says.
    expect(slot).toMatch(/^\{inWorkspace && inspectorColumn && !inspectorFolded && !\(detailOpen && selected\) \? \(\s*selected \? \(\s*<DetailAside[\s\S]*\) : <EmptyInspector \/>\s*\) : null\}\s*$/);
    const column = renderToStaticMarkup(createElement(EmptyInspector));
    expect(/<div class="insp-b insp-none">([\s\S]*?)<\/div>/.exec(column)?.[1]).toBe('<p class="insp-note">Choose a session to see its details.</p>');
    expect(column).not.toContain("insp-none-title");
    expect(column).not.toContain("No session in focus");
    expect(column).not.toContain("Open one from the list.");
  });

  it("leaves no catalog with the column's old two lines", () => {
    const dir = here("../i18n/areas/board/");
    for (const f of readdirSync(dir).filter(f => /^[a-zA-Z-]+\.ts$/.test(f))) {
      const text = readFileSync(dir + f, "utf8");
      expect(text, f).not.toContain('"board.inspector.emptyTitle"');
      expect(text, f).not.toContain('"board.inspector.emptyLine"');
    }
  });

  it("is said in all ten languages, each its own", () => {
    const dir = here("../i18n/areas/board/");
    const langs = readdirSync(dir).filter(f => /^[a-zA-Z-]+\.ts$/.test(f) && f !== "index.ts").sort();
    expect(langs).toEqual(["de.ts", "en.ts", "es.ts", "fr.ts", "ja.ts", "ko.ts", "pt-BR.ts", "ro.ts", "zh-CN.ts", "zh-TW.ts"]);
    const line = (f: string) => /"board\.inspector\.chooseSession": "([^"]+)"/.exec(readFileSync(dir + f, "utf8"))?.[1];
    expect(line("en.ts")).toBe("Choose a session to see its details.");
    for (const f of langs.filter(f => f !== "en.ts")) {
      expect(line(f), f).toBeTruthy();
      expect(line(f), f).not.toBe(line("en.ts"));
    }
  });
});

describe("a selected session", () => {
  it("still shows as it did: the session's Inspector is drawn first, and the line only with nothing selected", () => {
    expect(app).toMatch(/const detailOnScreen = detailShown \? selected : detailLeaving && !lastNothing\.current \? lastSelected\.current : null;/);
    expect(app).toMatch(/const nothingOnScreen = !\(inWorkspace && inspectorColumn\) && \(detailShown \? selected == null : detailLeaving && lastNothing\.current\);/);
    const at = app.indexOf("{detailOnScreen ? (");
    const slot = app.slice(at, app.indexOf("</div>", at));
    expect(slot.indexOf("<DetailAside")).toBeGreaterThan(-1);
    // CHANGED ON PURPOSE (owner 2026-11-18): drawn without `nothing`, which is gone.
    expect(slot.indexOf("nothingOnScreen ? <EmptyInspector leaving")).toBeGreaterThan(-1);
    expect(slot.indexOf("<DetailAside")).toBeLessThan(slot.indexOf("nothingOnScreen ? <EmptyInspector leaving"));
  });

  it("ends the line: choosing a session, or any close of the panel, clears it", () => {
    expect(app).toContain("useEffect(() => {\n    if (!detailOpen || primarySelectedId || (inWorkspace && inspectorColumn)) setInspectingNothing(false);\n  }, [detailOpen, primarySelectedId, inWorkspace, inspectorColumn]);");
  });
});
