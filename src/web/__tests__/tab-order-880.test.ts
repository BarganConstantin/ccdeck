// #880: tab order jumped across the screen.
//
// The panels are rendered in the order they were added, not the order they are
// seen: Usage (a fixed rail on the right) came first, then Claude accounts on
// the left, then the machine panel back on the right, and only then the canvas
// in the middle. A keyboard reader's focus went topbar, right, left, right,
// centre — measured live as topbar ×10 › usage ×4 › accounts ×26 › machine ×6
// › canvas ×46.
//
// The two right-hand rails are position: fixed, so where they sit in the DOM
// changes nothing on screen, only where Tab takes you. They are rendered after
// the canvas now, so the order reads the way the page does: the left column,
// the canvas, the right rails, then the detail panel at the far right.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const code = app
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

const at = (marker: string) => {
  const i = code.indexOf(marker);
  if (i < 0) throw new Error(`tab-order-880: no "${marker}" in App.tsx`);
  return i;
};

describe("tab order follows the page, left to right (#880)", () => {
  it("renders the left column before the canvas", () => {
    expect(at("<AccountsPanel")).toBeLessThan(at("<main"));
    expect(at("<SessionList")).toBeLessThan(at("<main"));
  });

  it("renders the two fixed right-hand rails after the canvas", () => {
    expect(at("<UsagePanel")).toBeGreaterThan(at("</main>"));
    expect(at("<MachinePanel")).toBeGreaterThan(at("</main>"));
  });

  it("keeps usage before machine, and both before the detail panel at the far right", () => {
    expect(at("<UsagePanel")).toBeLessThan(at("<MachinePanel"));
    expect(at("<MachinePanel")).toBeLessThan(at('<aside className="detail"'));
  });
});
