// The design source (V4's design docs and its Figma file) is private, so public
// code, tests, comments and docs say "V4's Figma" and "V4's motion rules" and
// name neither the private docs nor a Figma node id. This walks src/, scripts/,
// docs/ and .github/ and fails, naming the file and line.
//
// No public docs/ file is called motion, answers, components, tokens or
// surfaces .md (checked when this was written), so no path is excluded: any
// mention of those names is a reference to the private docs. The needle for the
// private folder is built from two halves so this file does not match itself,
// and the guard itself is skipped as well.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = fileURLToPath(import.meta.url);
const EXT = /\.(?:ts|tsx|mjs|js|css|md|yml|yaml)$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) && p !== SELF) out.push(p);
  }
  return out;
}

const RULES: Array<[string, (line: string) => boolean]> = [
  ["a private design doc name", line => /\b(?:motion|answers|components|tokens|surfaces)\.md\b/.test(line)],
  ["the private design folder", line => line.includes("design" + "-v4") || /\bbuild-order\b/.test(line)],
  ["a citation of the private answer list", line => /owner'?s? answer \d/i.test(line)],
  ["a Figma node id", line => /figma/i.test(line) && /\b\d{1,3}:\d{2,5}\b/.test(line)],
];

describe("public code names no private design source", () => {
  const files = ["src", "scripts", "docs", ".github"].flatMap(d => {
    try { return walk(join(ROOT, d)); } catch { return []; }
  });

  it("walks the tree it guards", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no private doc name, design folder, answer citation or Figma node id", () => {
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const [what, hit] of RULES) if (hit(line)) found.push(`${relative(ROOT, f)}:${i + 1} ${what}`);
      });
    }
    expect(found).toEqual([]);
  });
});
