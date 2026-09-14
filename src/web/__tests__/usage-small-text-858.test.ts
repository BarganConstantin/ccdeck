// #858: the usage panel set its section labels, ages, reset times, pace notes,
// credit line and range buttons at 10px (one at 9), much of it in --muted. It
// is a monitor people read all day, and the range buttons are controls.
//
// Content takes an 11px floor. 9-10px stays for uppercase eyebrows only, and
// colour rather than size carries secondary rank — what the type ladder's own
// note asks for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** [selector list, body] for every rule in the sheet. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const);

function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
}

/** The font-size the first rule for exactly this selector declares. */
function size(selector: string): number {
  const rule = RULES.find(([sel]) => sel.split(",").map(s => s.trim()).includes(selector));
  const v = rule && decl(rule[1], "font-size");
  if (!v) throw new Error(`${selector} declares no font-size`);
  return parseFloat(v);
}

/** What the issue listed, by the job each one does in the panel. */
const CONTENT = {
  "token keys": ".up-k",
  "what the strip counts": ".up-scope",
  "section ages": ".up-section-age",
  "table headings": ".up-table th",
  "reset times": ".qb-reset",
  "pace notes": ".qb-pace",
  "the limit badge": ".qb-limit-badge",
  "the plan badge": ".up-plan-badge",
  "the CLI command in the empty state": ".up-quota-hint code",
  "the credit line": ".up-quota-sub",
  "the range buttons": ".uh-range-btn",
};

describe("the usage panel's reading sizes (#858)", () => {
  for (const [job, selector] of Object.entries(CONTENT)) {
    it(`sets ${job} (${selector}) at the 11px floor`, () => {
      expect(size(selector)).toBeGreaterThanOrEqual(11);
    });
  }

  it("keeps anything under 11px in the panel for an uppercase eyebrow", () => {
    const small = RULES.filter(([sel, body]) => {
      if (!/(^|[\s,])\.(up|qb)-/.test(sel)) return false;
      const v = decl(body, "font-size");
      return v !== null && parseFloat(v) < 11;
    });
    const offenders = small
      .filter(([, body]) => decl(body, "text-transform") !== "uppercase")
      .map(([sel, body]) => `${sel} → ${decl(body, "font-size")}`);
    expect(offenders).toEqual([]);
  });

  it("is not a sweep over nothing", () => {
    expect(RULES.filter(([sel]) => /(^|[\s,])\.(up|qb)-/.test(sel)).length).toBeGreaterThan(40);
  });
});
