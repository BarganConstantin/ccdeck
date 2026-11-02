// The Inspector's Fold hands the keyboard to the pane, never the page. Found is
// not enough: a terminal under a state card is in the tree and refuses focus,
// so the walk must check each one took it before it stops.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLD_FOCUS_SELECTORS, focusFirstTaking } from "../fold-focus";

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

const [terminal, control, row] = FOLD_FOCUS_SELECTORS;

describe("the Fold's focus", () => {
  it("tries the terminal, then the pane's first control, then the session's row", () => {
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

  it("is what the Fold runs, a frame after it folds", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const at = app.indexOf("const foldInspector = useCallback(");
    const body = app.slice(at, app.indexOf("}, [setDetailOpen]);", at));
    expect(body).toMatch(/requestAnimationFrame\(\(\) => \{ focusFirstTaking\(document\); \}\);/);
  });
});
