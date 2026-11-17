// The bundle's target is ES2021 because esbuild, lowering `||=` for es2020,
// turned xterm's DECRQM handler into a ReferenceError and froze every pane on
// its first frame (scripts/build-target.mjs). Run, not read: the same shape
// goes through the same minifier at the configured target, and has to work.
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs build script, no types
import { BUILD_TARGET } from "../../../scripts/build-target.mjs";

/** xterm 6.0.0's requestMode, reduced to the statement that broke. */
const SHAPE = `export function requestMode(e, i) {
  let r;
  ((P) => (P[P.NOT_RECOGNIZED = 0] = "NOT_RECOGNIZED", P[P.SET = 1] = "SET"))(r ||= {});
  return i ? 1 : 2;
}`;

/** The minified module's function, called. The export line is swapped for a
 *  return of the same local name; the body, where the miscompile lives, runs
 *  exactly as esbuild wrote it. */
function run(code: string): (e: unknown, i: boolean) => number {
  const name = /export\s*\{\s*(\w+) as requestMode\s*\};?/.exec(code)?.[1];
  if (!name) throw new Error(`no requestMode export in: ${code}`);
  // Strict, as every module is: sloppy code would make the stray assignment a
  // global instead of the ReferenceError the bundle threw.
  return new Function(`"use strict";\n${code.replace(/export\s*\{[^}]*\};?/, "")}\nreturn ${name};`)();
}

describe("the web bundle's build target", () => {
  it("keeps xterm's mode report working once minified", () => {
    const { code } = transformSync(SHAPE, { minify: true, target: BUILD_TARGET, format: "esm" });
    expect(() => run(code)(null, true)).not.toThrow();
  });

  it("is the target vite builds with", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../vite.config.ts", import.meta.url)), "utf8");
    expect(config).toMatch(/import \{ BUILD_TARGET \} from "\.\/scripts\/build-target\.mjs";/);
    expect(config).toMatch(/build: \{[\s\S]*?target: BUILD_TARGET,/);
  });

  it("would have caught the bug: es2020 still miscompiles the same shape", () => {
    // If esbuild fixes the lowering this stops failing, and the target can be
    // reconsidered rather than kept out of habit.
    const { code } = transformSync(SHAPE, { minify: true, target: "es2020", format: "esm" });
    expect(() => run(code)(null, true)).toThrow(ReferenceError);
  });
});
