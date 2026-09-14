// #847: the usage and machine panels floated over the canvas instead of taking
// room, and below 1100px they covered most of it.
//
// Both were `position: fixed` overlays in the right-hand slot, side by side:
// with accounts, usage and machine open, 1024px left 148px of canvas, 768px
// left 20px, and a 1280 laptop at 200% zoom left none. The panels that describe
// the agents hid the agents, and auto-fit put cards under them.
//
// They stack in one `.rails` column now, and the canvas is padded by it, so
// React Flow's pane ends where the column begins. The app grid's own column
// rules are untouched — drift-pane-615.test.ts reads them as the six layouts
// the drift watchdog is checked against, and the watchdog measures the canvas's
// content box, which the padding already shrinks.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const app = read("../App.tsx");
const appCode = app
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(css)?.[1] ?? "";
}

describe("the two right-hand panels share one column (#847)", () => {
  it("renders both inside .rails, and the column only while one of them is there", () => {
    expect(appCode).toMatch(/\{\(isMounted\(usagePhase\) \|\| isMounted\(machinePhase\)\) && \(\s*<div className="rails">/);
    const rails = appCode.slice(appCode.indexOf('<div className="rails">'));
    expect(rails.indexOf("<UsagePanel")).toBeGreaterThan(-1);
    expect(rails.indexOf("<MachinePanel")).toBeGreaterThan(rails.indexOf("<UsagePanel"));
  });

  it("is the one fixed element in the rail's slot, 280px wide, stacking what is in it", () => {
    const r = rule(".rails");
    expect(r).toMatch(/position:\s*fixed/);
    expect(r).toMatch(/right:\s*var\(--rail-r\)/);
    expect(r).toMatch(/width:\s*280px/);
    expect(r).toMatch(/flex-direction:\s*column/);
  });

  it("lets each panel stay its own scroll box and give up height to the other", () => {
    const r = rule(".rails > .usage-panel,\n.rails > .sysdetail");
    expect(r).toMatch(/position:\s*static/);
    expect(r).toMatch(/min-height:\s*0/);
    expect(r).toMatch(/max-height:\s*none/);
  });
});

describe("the canvas makes room for the column (#847)", () => {
  it("pads the canvas by the column while it is open", () => {
    expect(rule(".app:has(.rails) .canvas-wrap")).toMatch(/padding-right:\s*296px/);
  });

  it("keeps the empty canvas's message in the middle of the part that can be seen", () => {
    expect(rule(".app:has(.rails) .empty-hero")).toMatch(/left:\s*calc\(50% - 148px\)/);
  });

  it("leaves the app grid's column rules to the six layouts the drift watchdog knows", () => {
    // The column is not a grid track, so no .app rule mentions it.
    expect(css).not.toMatch(/\.app:has\(\.rails\)\s*\{[^}]*grid-template-columns/);
  });
});
