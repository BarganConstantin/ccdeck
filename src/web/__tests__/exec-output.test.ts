// What a failed command said, as the accounts and claude-swap surfaces keep it.
//
// Seven sites in claude-accounts.mjs, cswap-install.mjs and cswap-auto.mjs
// wrote `(r.stderr || r.stdout).trim().slice(0, N)` out in full. It is one
// function in exec-output.mjs now, run here, and the three files are held to
// calling it rather than growing an eighth copy — as is cswap-auto-loop.mjs,
// whose tick spelled the rule an eighth way before it asked here too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs server module, no types
import { failureDetail } from "../../server/exec-output.mjs";

const server = (name: string) => readFileSync(new URL(`../../server/${name}`, import.meta.url), "utf8");
const failed = (stdout: string, stderr: string) => ({ ok: false, code: 1, killed: false, timedOut: false, stdout, stderr });

describe("failureDetail", () => {
  it("prefers what the tool wrote to stderr", () => {
    expect(failureDetail(failed("progress…", "error: slot 4 is empty\n"), 300)).toBe("error: slot 4 is empty");
  });

  it("falls back to stdout for a tool that reports failure there", () => {
    expect(failureDetail(failed("  No account in slot 4.\n", ""), 300)).toBe("No account in slot 4.");
  });

  it("cuts after trimming, so the budget is spent on words", () => {
    expect(failureDetail(failed("", `\n\n${"x".repeat(400)}\n`), 300)).toBe("x".repeat(300));
    expect(failureDetail(failed("", "abcdef"), 3)).toBe("abc");
  });

  it("is empty for a command that said nothing", () => {
    expect(failureDetail(failed("", ""), 300)).toBe("");
    expect(failureDetail(failed(" \n", ""), 300)).toBe("");
  });
});

describe("the four modules that keep a failure's words", () => {
  it("call the one helper instead of spelling it out", () => {
    for (const [file, calls] of [
      ["claude-accounts.mjs", 2], ["cswap-install.mjs", 3], ["cswap-auto.mjs", 2], ["cswap-auto-loop.mjs", 1],
    ] as const) {
      const text = server(file);
      expect(text, file).toContain('import { failureDetail } from "./exec-output.mjs";');
      expect(text.match(/failureDetail\(r, \d+\)/g) ?? [], file).toHaveLength(calls);
      expect(text, `${file} has a copy of the rule again`).not.toMatch(/\(r\.stderr \|\| r\.stdout\)\.trim\(\)\.slice\(/);
      expect(text, `${file} has the tick's old spelling again`).not.toMatch(/\(r\.stderr \|\| ""\)\.trim\(\)\.slice\(/);
    }
  });
});
