// #840: the canvas controls carried both React Flow's "fit view" and the deck's
// own "Recenter view". Recenter fits the same way and also turns autofit back
// on, so two near-identical buttons sat next to each other and the reader had
// to guess the difference. React Flow's is gone; Recenter is the one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP } from "../key-help";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const controls = /<Controls\b[^>]*>/.exec(app)?.[0] ?? "";

describe("one way to fit the canvas (#840)", () => {
  it("hides React Flow's own fit-view button", () => {
    expect(controls, "no <Controls> in App.tsx").not.toBe("");
    expect(controls).toMatch(/showFitView=\{false\}/);
    expect(controls).toMatch(/showInteractive=\{false\}/);
  });

  it("keeps Recenter, which fits and re-enables autofit", () => {
    expect(app).toMatch(/<ControlButton\s+onClick=\{enableAutoFitAndRefit\}/);
    expect(app).toMatch(/aria-label="Recenter view"/);
  });

  it("still fits from the keyboard", () => {
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.some(r => r.cap === "F" && /fit/i.test(r.action))).toBe(true);
  });
});
