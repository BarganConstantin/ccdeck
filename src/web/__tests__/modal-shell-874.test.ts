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

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const ctx = read("../components/ContextModal.tsx");
const history = read("../components/UsageHistoryModal.tsx");

/** [selector list, body] for every rule in the sheet. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const);

describe("every dialog composes the one .modal shell (#874)", () => {
  it("puts the context and usage-history dialogs on .modal-backdrop and .modal", () => {
    for (const [name, src, modifier] of [["ContextModal", ctx, "ctx-modal"], ["UsageHistoryModal", history, "uh-modal"]] as const) {
      expect(src, name).toMatch(/<div className="modal-backdrop" onClick=\{onClose\} role="presentation">/);
      expect(src, name).toContain(`className="modal ${modifier}"`);
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
      // A size inside the shell's own viewport margin, not `100%` of a backdrop
      // that no longer pads.
      expect(/width:\s*min\(\d+px,\s*92vw\)/.test(body!), `${sel} width`).toBe(true);
    }
  });

  it("names no dialog but .modal in the reduced-motion answer", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.sound-menu \{ animation: fadeIn 140ms ease-out; \}/.exec(css)?.[0] ?? "";
    expect(reduced, "the dialog block of the reduced-motion answer is missing").not.toBe("");
    expect(reduced).toMatch(/\.modal,/);
    expect(reduced).not.toMatch(/\.ctx-modal\b|\.uh-modal\b/);
  });
});
