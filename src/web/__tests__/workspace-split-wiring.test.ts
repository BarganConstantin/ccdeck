// Internal #102, the pieces around the split's model (workspace-split.test.ts)
// and the stage's (use-stage.test.ts "side by side"): ⇧↵ on a row, the page's
// own drag, where the list and the panes are wired, the sheet, and the words
// in every language.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBesideOnShiftEnter } from "../components/RailParts";
import { beginDrag, currentDrag, endDrag, isOurDrag, PANE_DRAG, SESSION_DRAG } from "../split-drag";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { sheetParts, sheetText } from "./sheet-source";
import { en } from "../i18n/en";
import ro from "../i18n/areas/board/ro";
import de from "../i18n/areas/board/de";
import fr from "../i18n/areas/board/fr";
import es from "../i18n/areas/board/es";
import ptBR from "../i18n/areas/board/pt-BR";
import ja from "../i18n/areas/board/ja";
import ko from "../i18n/areas/board/ko";
import zhCN from "../i18n/areas/board/zh-CN";
import zhTW from "../i18n/areas/board/zh-TW";

const press = (over: Partial<{ key: string; repeat: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: "Enter", repeat: false, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), ...over,
});

describe("⇧↵ on a row opens the session beside the pane in focus", () => {
  it("opens it, and is the row's only use of the press", () => {
    const beside = vi.fn();
    const e = press();
    expect(openBesideOnShiftEnter("s1", beside)!(e)).toBe(true);
    expect(beside).toHaveBeenCalledWith("s1");
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("leaves the bare Enter (openKeysOnEnter's), a held one and other chords alone", () => {
    const beside = vi.fn();
    const handler = openBesideOnShiftEnter("s1", beside)!;
    for (const over of [{ shiftKey: false }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: "j" }]) {
      const e = press(over);
      expect(handler(e), JSON.stringify(over)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(beside).not.toHaveBeenCalled();
  });

  it("is nothing on the Board, where the list has no beside", () => {
    expect(openBesideOnShiftEnter("s1", undefined)).toBeUndefined();
  });
});

describe("the page's own drag", () => {
  afterEach(() => endDrag());
  const transfer = () => {
    const set = new Map<string, string>();
    return { set, dt: { setData: (t: string, d: string) => { set.set(t, d); }, effectAllowed: "" } };
  };

  it("carries our type and the id, never plain text a terminal would type", () => {
    const { set, dt } = transfer();
    beginDrag({ dataTransfer: dt }, { kind: "session", id: "s1", name: "Fix login" }, undefined);
    expect([...set.keys()]).toEqual([SESSION_DRAG]);
    expect(set.get(SESSION_DRAG)).toBe("s1");
    expect(dt.effectAllowed).toBe("move");
    expect(currentDrag()).toEqual({ kind: "session", id: "s1", name: "Fix login" });
  });

  it("knows a pane's drag from a session's, and a file from the desktop is not ours", () => {
    const { set, dt } = transfer();
    beginDrag({ dataTransfer: dt }, { kind: "pane", id: "p1", name: "Fix login" }, undefined);
    expect([...set.keys()]).toEqual([PANE_DRAG]);
    expect(isOurDrag([PANE_DRAG])).toBe(true);
    expect(isOurDrag([SESSION_DRAG])).toBe(true);
    expect(isOurDrag(["Files"])).toBe(false);
    expect(isOurDrag(["text/plain"])).toBe(false);
    expect(isOurDrag(null)).toBe(false);
  });

  it("ends with the drag, dropped or not", () => {
    const { dt } = transfer();
    beginDrag({ dataTransfer: dt }, { kind: "session", id: "s1", name: "x" }, undefined);
    endDrag();
    expect(currentDrag()).toBeNull();
  });
});

describe("where the list and the panes are wired", () => {
  const parts = withoutComments(sourceOf("components/RailParts.tsx"));
  const list = withoutComments(sourceOf("components/SessionList.tsx"));
  const app = withoutComments(sourceOf("App.tsx"));
  const shell = withoutComments(sourceOf("components/terminal/StageShell.tsx"));

  it("drags a row only where it can open beside, and never a row off the board", () => {
    expect(parts).toContain("const beside = removed ? undefined : onOpenBeside;");
    expect(parts).toContain("draggable={beside ? true : undefined}");
    expect(parts).toContain('beginDrag(e, { kind: "session", id: r.sessionId, name: r.label });');
    expect(parts).toContain("onDragEnd={beside ? () => { setDragging(false); endDrag(); } : undefined}");
    expect(list).toContain("onOpenBeside={e.ghost ? undefined : onOpenBeside}");
  });

  it("gives the list a beside only in Workspace, with the Command Panel on", () => {
    expect(app).toContain("onOpenBeside={inWorkspace && stage.enabled ? openSessionBeside : undefined}");
    // A row off the board comes back first, as Enter's does.
    expect(app).toMatch(/const openSessionBeside = useCallback\(\(sessionId: string\) => \{\s*if \(removedAgentIds\.has\(sessionId\)\) bringBack\(\[sessionId\]\);\s*stage\.openBeside\(sessionId\);/);
    // A kept split closes the panes whose session the deck no longer has, once it has heard its history.
    expect(app).toContain("ready: historyReplayed");
  });

  it("drops a pane where it is, a session already open on its pane, and a new one beside", () => {
    expect(shell).toContain('if (dragged.kind === "pane") stage.movePaneTo(dragged.id, view.pane, view.zone);');
    expect(shell).toContain("else if (view.already) stage.focusPaneId(view.pane, { keys: true });");
    expect(shell).toContain('else if (view.zone === "here") stage.dropHere(view.pane, dragged.id);');
    expect(shell).toContain("else stage.openBeside(dragged.id, { at: view.pane, zone: view.zone });");
    // Only on the Workspace's cell, never the Board's stage.
    expect(shell).toContain("onDropCapture={fill ? onDrop : undefined}");
  });

  it("closes a pane alone when panes stand side by side", () => {
    expect(shell).toContain("const close = multi ? () => stage.closePane(id)");
  });

  it("shows, not only speaks, why a fifth session took the pane in focus", () => {
    expect(shell).toContain('<p className="wsp-note" role="status" aria-atomic="true" data-on={stage.splitNote ? true : undefined}>');
    const hook = withoutComments(sourceOf("use-stage.ts"));
    expect(hook).toContain('setSplitNote(n => ({ text: t("board.stage.split.full"), n: (n?.n ?? 0) + 1 }));');
    expect(hook).toContain("const id = setTimeout(() => setSplitNote(null), SPLIT_NOTE_MS);");
    expect(sheetText()).toContain(".wsp-note[data-on] { opacity: 1; }");
  });

  it("says why the strip shows tabs when the Workspace is too narrow, and what makes room", () => {
    expect(shell).toContain('{arrangement.why === "narrow" && (');
    expect(shell).toContain('<span className="wsp-why" title={t("board.stage.split.narrowHint")}>');
    expect(shell).toContain('{t("board.stage.split.narrow")}');
  });
});

describe("the sheet", () => {
  const css = sheetText();

  it("is loaded after Workspace's own", () => {
    const order = sheetParts().map(([path]) => path);
    expect(order.indexOf("styles/workspace-split.css")).toBeGreaterThan(order.indexOf("styles/workspace.css"));
    expect(order.indexOf("styles/workspace.css")).toBeGreaterThan(-1);
  });

  it("hides a pane behind the strip without unmounting it, and marks the pane with the keys", () => {
    expect(css).toContain(".wsp-pane[data-hidden] { visibility: hidden; }");
    expect(css).toContain(".stage-in[data-split] .wsp-pane[data-focused] .ts-head { background: color-mix(in srgb, var(--text) 5%, var(--panel)); }");
    expect(css).toContain(".stage-in[data-split] .wsp-pane:not([data-focused]) .ts-name { color: var(--text-secondary); }");
  });

  it("gives the line between panes a hold wider than its pixel, and the cursor that says which way", () => {
    expect(css).toContain('.wsp-divider[data-dir="row"] { cursor: col-resize; }');
    expect(css).toContain('.wsp-divider[data-dir="col"] { cursor: row-resize; }');
    expect(css).toContain('.wsp-divider[data-dir="row"]::before { inset: 0 -4px; }');
  });
});

describe("the words, in every language", () => {
  const KEYS = ["full", "maximize", "restore", "strip", "divider", "showAll", "narrow", "narrowHint", "already", "showHere", "openBeside", "openAbove", "openBelow", "moveSwap", "moveBeside", "moveAbove", "moveBelow"]
    .map(k => `board.stage.split.${k}`);
  const langs: Record<string, Record<string, string>> = { ro, de, fr, es, "pt-BR": ptBR, ja, ko, "zh-CN": zhCN, "zh-TW": zhTW };
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

  it("has every key in English", () => {
    for (const k of KEYS) expect(en[k], k).toBeTruthy();
    expect(en["board.stage.split.openBeside"]).toBe("Open {name} beside");
  });

  for (const [lang, cat] of Object.entries(langs)) {
    it(`says them in ${lang}, with the same {placeholders}`, () => {
      for (const k of KEYS) {
        expect(cat[k], `${lang} ${k}`).toBeTruthy();
        expect(cat[k], `${lang} ${k} is translated`).not.toBe(en[k]);
        expect(holes(cat[k]!), `${lang} ${k}`).toEqual(holes(en[k]!));
      }
    });
  }
});
