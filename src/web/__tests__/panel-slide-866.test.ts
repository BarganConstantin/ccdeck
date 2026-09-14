// #866: opening or closing the accounts panel animated its width. The panel is
// the grid's first column and the canvas its 1fr neighbour, so every frame of
// the 260ms re-laid the canvas out and React Flow re-measured it. The panel
// keeps its 288px from the first frame now and slides from its own left edge,
// so the canvas takes its new width once.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

const frames = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{([^{}]*\\{[^}]*\\})+\\s*\\}`).exec(css)?.[0] ?? "";
const body = (selector: string) =>
  new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("the accounts panel slides rather than wipes (#866)", () => {
  it("moves by transform in and out, and never by width", () => {
    for (const name of ["side-in", "side-out"]) {
      const kf = frames(name);
      expect(kf, `no @keyframes ${name}`).not.toBe("");
      expect(kf, name).toMatch(/transform:\s*translateX\(-100%\)/);
      expect(kf, name).not.toMatch(/\bwidth\s*:/);
    }
  });

  it("keeps its width from the first frame, so the canvas resizes once", () => {
    expect(body(".accounts-panel")).toMatch(/width:\s*288px/);
    expect(body(".accounts-panel")).toMatch(/animation:\s*side-in 260ms/);
    expect(body(".accounts-panel.leaving")).toMatch(/animation:\s*side-out var\(--side-exit\)/);
  });

  it("still arrives as a fade under reduced motion", () => {
    expect(raw).toMatch(/\.accounts-panel \{ animation: fadeIn 140ms ease both; \}/);
    expect(raw).toMatch(/\.accounts-panel\.leaving \{ animation: canvas-fade-out var\(--side-exit\) linear both; \}/);
  });
});
