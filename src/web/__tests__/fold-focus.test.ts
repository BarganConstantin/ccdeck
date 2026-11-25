// The Inspector's Fold hands the keyboard to the pane, never the page. Found is
// not enough: a terminal under a state card is in the tree and refuses focus,
// so the walk must check each one took it before it stops.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLD_FOCUS_SELECTORS, focusAfterFold, focusFirstTaking } from "../fold-focus";
import { sourceOf } from "./client-source";

/** A document of fake elements: `takes` says whether one keeps the focus. */
function page(present: Record<string, boolean>) {
  const root = {
    activeElement: null as unknown,
    tried: [] as string[],
    querySelector(selector: string) {
      if (!(selector in present)) return null;
      return {
        focus() {
          root.tried.push(selector);
          if (present[selector]) root.activeElement = this;
        },
      };
    },
  };
  return root as typeof root & { activeElement: Element | null };
}

const [paneTerminal, paneControl, terminal, control, row] = FOLD_FOCUS_SELECTORS;

/** The Workspace as the walk reads it: the panes in tree order, each with its
 *  terminal and a button. `focused` is the pane StageShell marks data-focused
 *  (a split only); `refuses` is a terminal under a state card. The selectors
 *  answer as the browser's do: the first match in tree order. */
function workspace(panes: { id: string; focused?: boolean; refuses?: boolean }[]) {
  type Pane = (typeof panes)[number];
  const root = { activeElement: null as unknown };
  const element = (pane: Pane, kind: "terminal" | "button") => ({
    pane: pane.id,
    kind,
    focus() { if (kind === "button" || !pane.refuses) root.activeElement = this; },
  });
  const tree = panes.flatMap(pane => [element(pane, "terminal"), element(pane, "button")]);
  const marked = new Set(panes.filter(pane => pane.focused).map(pane => pane.id));
  const querySelector = (selector: string) => {
    if (!selector.startsWith(".stage-dock ")) return null;
    const kind = selector.endsWith(" .xterm-helper-textarea") ? "terminal"
      : selector.endsWith(" button:not(:disabled)") ? "button" : null;
    const inMarked = selector.includes(" .wsp-pane[data-focused] ");
    return tree.find(el => el.kind === kind && (!inMarked || marked.has(el.pane))) ?? null;
  };
  return Object.assign(root, { querySelector }) as typeof root & {
    activeElement: (typeof tree)[number] | null;
    querySelector: typeof querySelector;
  };
}

describe("the Fold's focus", () => {
  it("tries the focused pane's terminal and control, then the first terminal, the first control, the session's row", () => {
    expect(paneTerminal).toBe(".stage-dock .wsp-pane[data-focused] .xterm-helper-textarea");
    expect(paneControl).toBe(".stage-dock .wsp-pane[data-focused] button:not(:disabled)");
    expect(terminal).toBe(".stage-dock .xterm-helper-textarea");
    expect(control).toBe(".stage-dock button:not(:disabled)");
    expect(row).toBe(".sl-row[aria-current=\"true\"]");
  });

  it("stops at the terminal when it takes the focus", () => {
    const doc = page({ [terminal]: true, [control]: true, [row]: true });
    expect(focusFirstTaking(doc)).toBe(doc.activeElement);
    expect(doc.tried).toEqual([terminal]);
  });

  it("moves on from a terminal that is there but refuses focus", () => {
    const doc = page({ [terminal]: false, [control]: true, [row]: true });
    expect(focusFirstTaking(doc)).not.toBeNull();
    expect(doc.tried).toEqual([terminal, control]);
  });

  it("falls back to the rail's row when the pane has nothing that takes it", () => {
    const doc = page({ [terminal]: false, [row]: true });
    expect(focusFirstTaking(doc)).not.toBeNull();
    expect(doc.tried).toEqual([terminal, row]);
  });

  it("returns null when nothing takes it", () => {
    const doc = page({ [terminal]: false, [control]: false });
    expect(focusFirstTaking(doc)).toBeNull();
    expect(doc.activeElement).toBeNull();
  });

  it("in a split, gives the keys back to the pane that had them, not the first", () => {
    const doc = workspace([{ id: "p0" }, { id: "p1", focused: true }]);
    const at = focusAfterFold(doc as never);
    expect(at).toBe(doc.activeElement);
    expect(doc.activeElement).toMatchObject({ pane: "p1", kind: "terminal" });
  });

  it("in a split, a focused pane whose terminal refuses gives the keys to its own control", () => {
    const doc = workspace([{ id: "p0" }, { id: "p1", focused: true, refuses: true }]);
    focusAfterFold(doc as never);
    expect(doc.activeElement).toMatchObject({ pane: "p1", kind: "button" });
  });

  it("with one pane, which carries no mark, walks to its terminal as it always did", () => {
    const doc = workspace([{ id: "p0" }]);
    focusAfterFold(doc as never);
    expect(doc.activeElement).toMatchObject({ pane: "p0", kind: "terminal" });
  });

  it("reads the mark StageShell puts on the pane with the keys, and only when there are several", () => {
    expect(sourceOf("components/terminal/StageShell.tsx")).toContain('"data-focused": (p.multi && p.focused) || undefined,');
  });

  it("is what the Fold runs, a frame after it folds", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const at = app.indexOf("const foldInspector = useCallback(");
    const body = app.slice(at, app.indexOf("}, [setDetailOpen]);", at));
    // CHANGED ON PURPOSE (V4's Figma): when the pane takes no focus the keyboard goes to the
    // folded Inspector's tab (focusAfterFold), never onto nothing.
    expect(body).toMatch(/requestAnimationFrame\(\(\) => \{ focusAfterFold\(document\); \}\);/);
  });
});
