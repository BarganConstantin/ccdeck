// #879: the machine panel was the only panel with no heading.
//
// It is a labelled <aside>, and Usage and Claude accounts each open with an
// <h2>, but the machine panel's title was a styled <span> — so a screen-reader
// user moving by heading went from "Usage" to "Claude accounts" and never
// landed on it. Its title is the heading now, and the landmark takes its name
// from that heading, the way a region and its title should agree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const panel = read("../components/MachinePanel.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the machine panel has a heading (#879)", () => {
  it("draws its title as an h2", () => {
    expect(panel).toMatch(/<h2 className="sd-title" id="sd-title">This machine<\/h2>/);
    expect(panel).not.toMatch(/<span className="sd-title">/);
  });

  it("names its landmark after that heading", () => {
    expect(panel).toMatch(/<aside[^>]*id="system-panel"[^>]*aria-labelledby="sd-title"/);
    expect(panel).not.toMatch(/aria-label="Machine detail"/);
  });

  it("keeps the title's look: no heading margin arrives with the tag", () => {
    const rule = /^\.sd-title\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/margin:\s*0/);
    expect(rule).toMatch(/font-size:\s*12px/);
  });
});
