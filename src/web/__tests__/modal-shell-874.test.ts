// #874: fifteen of seventeen dialogs composed the `.modal` shell. The context
// breakdown ran on `.ctx-modal` + `.ctx-modal-backdrop` and the usage history
// on `.uh-modal` + `.uh-backdrop`: three backdrops with their own radius,
// shadow and padding, a reduced-motion block that had to name all three, and
// fixes to `.modal` — the light scrim, the backdrop blur — that never reached
// the two copies (#875 had to fix one by hand). Both compose the shell now, and
// their own rules keep only what they differ in.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const ctx = read("../components/ContextModal.tsx");
const history = read("../components/UsageHistoryModal.tsx");
const shell = read("../components/Dialog.tsx");

/** [selector list, body] for every rule in the sheet. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const);

describe("every dialog composes the one .modal shell (#874)", () => {
  it("puts the context and usage-history dialogs on .modal-backdrop and .modal", () => {
    for (const [name, src, modifier] of [["ContextModal", ctx, "ctx-modal"], ["UsageHistoryModal", history, "uh-modal"]] as const) {
      // The scrim and the `modal` class are Dialog.tsx's; the dialog hands it
      // its scrim press and its own modifier.
      expect(src, name).toMatch(/<Dialog\s[^>]*scrim=\{scrimPress\}/);
      expect(src, name).toMatch(new RegExp(`<Dialog\\s[^>]*className="${modifier}"`));
      expect(src, name).not.toContain('className="modal-backdrop"');
      expect(shell).toContain('"modal-backdrop"');
      expect(shell).toContain("`modal ${className}`");
    }
  });

  it("leaves no private backdrop or shell rule behind", () => {
    for (const gone of [".ctx-modal-backdrop", ".uh-backdrop", ".ctx-modal", ".uh-modal"]) {
      const hits = RULES.filter(([sel]) => sel.split(",").map(s => s.trim())
        .some(s => s === gone || s.endsWith(` ${gone}`)));
      expect(hits.map(([sel]) => sel), gone).toEqual([]);
    }
  });

  it("keeps only what each dialog differs in — no second surface, edge, shadow or entrance", () => {
    for (const sel of [".modal.ctx-modal", ".modal.uh-modal"]) {
      const body = RULES.find(([s]) => s === sel)?.[1];
      expect(body, `${sel} is missing`).toBeTruthy();
      for (const shell of ["background", "border", "border-radius", "box-shadow", "animation"]) {
        expect(new RegExp(`(?:^|[;\\s])${shell}\\s*:`).test(body!), `${sel} redeclares ${shell}`).toBe(false);
      }
      // One of the three dialog widths (tokens.css, "One dialog frame"), each
      // inside the window's own margin, not `100%` of a backdrop that no
      // longer pads.
      expect(/width:\s*var\(--dialog-[sml]\)/.test(body!), `${sel} width`).toBe(true);
    }
  });

  it("names no dialog but .modal in the reduced-motion answer", () => {
    // The block ended on the sound popover's own line once the Appearance menu
    // that shared it was gone, and on .modal's alone since the popover left
    // with the topbar speaker (2026-10-07).
    // (.modal now answers with a transition, not a fadeIn keyframe.)
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.modal \{ transition-property: opacity; \}/.exec(css)?.[0] ?? "";
    expect(reduced, "the dialog block of the reduced-motion answer is missing").not.toBe("");
    expect(reduced).not.toMatch(/\.ctx-modal\b|\.uh-modal\b/);
  });
});
