// #841: the details rail's activity chips were an emoji and a count, with the
// category only in a title — invisible without hovering, and never reachable by
// keyboard or touch. Each chip now says its category as a word at rest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const taxonomy = read("../tool-taxonomy.ts");

const chip = /<span\s+className=\{`cat-chip cat-[\s\S]*?<\/span>\s*\);/.exec(app)?.[0] ?? "";

describe("the rail's activity chips say their category (#841)", () => {
  it("finds the chip markup", () => {
    expect(chip, "no cat-chip in App.tsx").not.toBe("");
  });

  it("renders the category word at rest, between the emoji and the count", () => {
    const emoji = chip.indexOf('className="cat-emoji"');
    const name = chip.indexOf('<span className="cat-name">{DETAIL_CAT_LABEL[c]}</span>');
    const count = chip.indexOf('className="cat-count"');
    expect(name).toBeGreaterThan(emoji);
    expect(count).toBeGreaterThan(name);
  });

  it("makes the emoji decoration, now that the word carries the meaning", () => {
    expect(chip).toMatch(/<span className="cat-emoji" aria-hidden>/);
  });

  it("has a word for every category the taxonomy knows", () => {
    const union = /export type ToolCategory\s*=([^;]*);/.exec(taxonomy)![1];
    const cats = [...union.matchAll(/"([a-z][a-z0-9-]*)"/g)].map(m => m[1]);
    const labels = /const DETAIL_CAT_LABEL: Record<DetailCategory, string> = \{([\s\S]*?)\};/.exec(app)![1];
    for (const c of cats) expect(labels, c).toMatch(new RegExp(`\\b${c}: "`));
  });

  it("draws the word in the key tier, at the chip's own size", () => {
    const rule = /(?:^|\n)\.cat-chip \.cat-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--muted\)/);
    expect(rule).not.toMatch(/font-size/);
  });
});
