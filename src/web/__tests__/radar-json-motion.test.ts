// Reduced motion reaches the JSON tree Radar borrows from json-edit-react.
//
// WHAT WAS OBSERVED. The library injects its own stylesheet when the tree first
// renders: its icons grow to 1.2x on hover over 0.3 s, and the copy button
// rings (a box-shadow pulse over 0.5 s) as it is released. Radar's own controls
// already drop their press scale under `prefers-reduced-motion: reduce`; the
// tree's icons did not, so headless Chromium with reduced motion still listed
// the copy button's transition in Radar's inspector.
//
// The override lives in styles/traffic-radar.css, scoped to `.tr-json-tree` so
// that it outranks the library's one-class rules and touches nothing else. The
// library half of this file reads the build the bundle is made from, so a
// version that renames these rules fails here rather than leaving the override
// aimed at nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const css = readFileSync(join(repo, "src/web/styles/traffic-radar.css"), "utf8");
const library = readFileSync(join(repo, "node_modules/json-edit-react/build/index.esm.js"), "utf8");

/** Every `@media (prefers-reduced-motion: reduce)` block in the sheet, each
 *  bounded to its own braces (as history-motion-810.test.ts reads them). */
function reducedMotion(sheet: string): string {
  const out: string[] = [];
  const query = "@media (prefers-reduced-motion: reduce)";
  for (let at = sheet.indexOf(query); at !== -1; at = sheet.indexOf(query, at + 1)) {
    let depth = 0;
    for (let i = sheet.indexOf("{", at); i < sheet.length; i++) {
      if (sheet[i] === "{") depth++;
      else if (sheet[i] === "}" && --depth === 0) { out.push(sheet.slice(at, i + 1)); break; }
    }
  }
  expect(out.length, "no reduced-motion blocks in traffic-radar.css").toBeGreaterThan(0);
  return out.join("\n");
}

describe("the JSON tree's icons under reduced motion", () => {
  it("finds the motion it switches off in the stylesheet json-edit-react injects", () => {
    expect(library).toContain(".jer-icon:hover{opacity:.85;transition:.3s;transform:scale(1.2)}");
    expect(library).toContain(".jer-copy-pulse:hover{opacity:.85;transition:.3s;transform:scale(1.2)}");
    expect(library).toMatch(/\.jer-copy-pulse:after\{[^}]*transition:all \.5s;box-shadow:0 0 15px 5px/);
  });

  it("drops the hover growth and the copy ring, keeping the colour change", () => {
    const reduced = reducedMotion(css);
    expect(reduced).toContain(".tr-json-tree :is(.jer-icon, .jer-copy-pulse):hover { transform: none; }");
    expect(reduced).toContain(".tr-json-tree :is(.jer-icon, .jer-copy-pulse), .tr-json-tree .jer-copy-pulse::after { transition: none; }");
    expect(reduced).toContain(".tr-json-tree .jer-copy-pulse::after { box-shadow: none; }");
    // Opacity is the library's colour cue on hover; it is not motion and stays.
    expect(reduced).not.toMatch(/\.tr-json-tree[^{]*\{[^}]*opacity/);
  });
});
