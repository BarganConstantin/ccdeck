// Hover is for mice (V4's motion rules, rule 9): every rule a :hover selector
// styles sits under @media (hover: hover) and (pointer: fine), so a tap on a
// touch screen never leaves a control lit and a pen or a coarse pointer gets no
// hover state it cannot leave. A :hover only inside :not(...) styles the
// resting state, not the hover, and is left where it is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function sheets(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sheets(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

/** The selector less every :not(...) group. */
function withoutNegations(sel: string): string {
  let s = sel;
  for (let at = s.indexOf(":not("); at >= 0; at = s.indexOf(":not(")) {
    let depth = 0, i = at + 4;
    for (; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")" && --depth === 0) break; }
    s = s.slice(0, at) + s.slice(i + 1);
  }
  return s;
}

const MICE = (header: string) => /^@media\b/.test(header) && /\(hover:\s*hover\)/.test(header) && /\(pointer:\s*fine\)/.test(header);

/** Every block header with a positive :hover and no mouse query around it, as file:line. */
function bareHovers(file: string): string[] {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  const stack: string[] = [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const header = css.slice(start, i).trim();
      if (!header.startsWith("@") && !stack.some(h => /^@(?:-webkit-)?keyframes\b/.test(h))
        && header.split(",").some(sel => /:hover\b/.test(withoutNegations(sel)))
        && !stack.some(MICE)) {
        out.push(`${relative(WEB, file)}:${css.slice(0, i).split("\n").length} ${header.replace(/\s+/g, " ").slice(0, 80)}`);
      }
      stack.push(header);
      start = i + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    } else if (ch === ";") {
      start = i + 1;
    }
  }
  return out;
}

describe("hover is for mice", () => {
  const files = sheets(WEB);

  it("reads the stylesheets", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("puts every :hover rule under (hover: hover) and (pointer: fine)", () => {
    expect(files.flatMap(bareHovers)).toEqual([]);
  });

  it("says (pointer: fine) wherever it says (hover: hover)", () => {
    const half: string[] = [];
    for (const f of files) {
      const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/@media[^{]*\(hover:\s*hover\)[^{]*\{/g)) if (!/\(pointer:\s*fine\)/.test(m[0])) half.push(`${relative(WEB, f)} ${m[0]}`);
    }
    expect(half).toEqual([]);
  });
});
