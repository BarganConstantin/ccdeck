// #867: the topbar mark was a cyan-pink-green conic gradient in a rounded
// square with a 12px cyan halo, the only permanent decorative glow in a sheet
// that keeps glow for state. The mark is where the deck says who it is, so it
// is now the favicon's own shape: a flat ring, one token, no halo. The tab and
// the page carry the same mark; the tab's copy is the one that changes with
// state.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const html = read("../index.html");
const app = read("../App.tsx");

const logo = /\.topbar \.brand \.logo\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

describe("the topbar mark is a flat ring (#867)", () => {
  it("is still the span beside the wordmark", () => {
    expect(app).toMatch(/<div className="brand">\s*<span className="logo" \/>/);
  });

  it("draws a ring, the favicon's shape", () => {
    // The favicon is one circle with a stroke and no fill.
    const icon = decodeURIComponent(/rel="icon" href="([^"]+)"/.exec(html)![1]);
    expect(icon).toMatch(/<circle[^>]*fill="none"[^>]*stroke=/);
    expect(logo).toMatch(/border-radius:\s*50%/);
    expect(logo).toMatch(/border:\s*2px solid var\(--accent\)/);
    expect(logo).toMatch(/background:\s*none/);
  });

  it("uses one token and no gradient or halo", () => {
    expect(logo).not.toMatch(/gradient/);
    expect(logo).not.toMatch(/box-shadow/);
    expect(logo).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/\.brand \.logo[^{]*\{[^}]*(gradient|box-shadow)/);
  });
});
