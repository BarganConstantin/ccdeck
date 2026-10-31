// #875: the context-breakdown dialog kept a black 55% scrim and a black 50%
// shadow on the light theme. Every other dialog's scrim turns to a slate 30%
// there (.modal-backdrop, .uh-backdrop), and .modal's shadow is --shadow-2,
// which each theme block tunes for its own canvas.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

const LIGHT = ':root[data-color-scheme="light"] ';

// #874 then put this dialog on the shared .modal shell, so the scrim and the
// shadow are .modal-backdrop's and .modal's — one rule each rather than a copy.
const ctx = readFileSync(fileURLToPath(new URL("../components/ContextModal.tsx", import.meta.url)), "utf8");

describe("the context-breakdown dialog on the light theme (#875)", () => {
  it("dims the page with the scrim every other dialog uses there", () => {
    // V4's dialog frame: the scrim is the theme's own --scrim token, so the
    // light answer is the light theme's value and there is no light rule here.
    expect(decl(".modal-backdrop", "--modal-scrim")).toBe("var(--scrim)");
    expect(decl(`${LIGHT}.modal-backdrop`, "--modal-scrim")).toBeNull();
    expect(ctx).toMatch(/className="modal-backdrop"/);
    // No copy of the scrim left to drift from it.
    expect(decl(`${LIGHT}.ctx-modal-backdrop`, "background")).toBeNull();
  });

  it("casts the shadow each theme tunes for its own canvas, as .modal does", () => {
    // V4's dialog frame: --shadow-overlay, a token each theme tunes (was --shadow-2).
    expect(decl(".modal", "box-shadow")).toBe("var(--shadow-overlay)");
    expect(ctx).toMatch(/className="modal ctx-modal"/);
    expect(decl(".modal.ctx-modal", "box-shadow")).toBeNull();
  });
});
