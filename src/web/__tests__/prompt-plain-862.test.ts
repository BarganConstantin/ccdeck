// #862: the session summary's "Opening prompt" box wore a 3px accent stripe
// down its left edge, on top of its own 1px border. A thick coloured side tab
// on a callout is a stock pattern, and here it spent the accent colour on a
// static quote. It is plain text now (V4's Figma): no ground, no hairline.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");
const summary = readFileSync(fileURLToPath(new URL("../components/SessionSummary.tsx", import.meta.url)), "utf8");

const prompt = /\.session-summary \.ss-prompt\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

describe("the opening prompt is plain text (#862)", () => {
  it("still renders the prompt in its box", () => {
    expect(summary).toMatch(/<h4>\{t\("insights\.summary\.opening"\)\}<\/h4>\s*<div className="ss-prompt">\{summary\.firstPrompt\}<\/div>/);
  });

  it("is plain text with no ground and no hairline", () => {
    // CHANGED ON PURPOSE (V4's Figma): the opening prompt is plain text, 13/20 in
    // the second text step, under its label. It is no longer an inset block, so
    // neither the soft ground nor the hairline stays.
    expect(prompt).not.toMatch(/background/);
    expect(prompt).not.toMatch(/border/);
    expect(prompt).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it("has no side stripe, in this rule or any other", () => {
    expect(prompt).not.toMatch(/border-left/);
    expect(css).not.toMatch(/\.ss-prompt[^{]*\{[^}]*border-(left|inline-start)\s*:/);
    expect(prompt).not.toMatch(/var\(--accent\)/);
  });
});
