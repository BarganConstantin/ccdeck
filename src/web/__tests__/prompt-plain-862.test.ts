// #862: the session summary's "Opening prompt" box wore a 3px accent stripe
// down its left edge, on top of its own 1px border. A thick coloured side tab
// on a callout is a stock pattern, and here it spent the accent colour on a
// static quote. The box is a plain inset block now: the soft ground and the
// hairline every other well in the dialog uses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const summary = readFileSync(fileURLToPath(new URL("../components/SessionSummary.tsx", import.meta.url)), "utf8");

const prompt = /\.session-summary \.ss-prompt\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

describe("the opening prompt is a plain inset block (#862)", () => {
  it("still renders the prompt in its box", () => {
    expect(summary).toMatch(/<h4>Opening prompt<\/h4>\s*<div className="ss-prompt">\{summary\.firstPrompt\}<\/div>/);
  });

  it("keeps the soft ground and one hairline all the way round", () => {
    expect(prompt).toMatch(/background:\s*var\(--bg-soft\)/);
    expect(prompt).toMatch(/border:\s*1px solid var\(--line\)/);
  });

  it("has no side stripe, in this rule or any other", () => {
    expect(prompt).not.toMatch(/border-left/);
    expect(css).not.toMatch(/\.ss-prompt[^{]*\{[^}]*border-(left|inline-start)\s*:/);
    expect(prompt).not.toMatch(/var\(--accent\)/);
  });
});
