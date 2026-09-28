// #1326: with the Accounts panel open, the Detail panel covered the whole canvas.
//
// Both left panels — the session list and Accounts — share one slot and add a
// grid column when they open, so everything the two-column grid places in
// column 2 has to move one column to the right under either of them. The canvas
// and both banners had a rule for each panel; the Detail panel had one only for
// the session list, and with Accounts open it stayed in column 2, which by then
// was the canvas's `1fr` track.
//
// The invariant is the pairing itself, not the one line that was missing: any
// placement written for one left panel must be written for the other, with the
// same column, so the next element given a column under one of them cannot
// drift the same way.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** `descendant selector → grid-column` for every rule scoped to `.app:has(.<panel>)`. */
function placements(panel: string): Map<string, string> {
  const prefix = `.app:has(.${panel}) `;
  const out = new Map<string, string>();
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const column = /grid-column:\s*([^;]+);/.exec(body)?.[1].trim();
    if (!column) continue;
    for (const sel of selectors.split(",").map(s => s.trim())) {
      if (sel.startsWith(prefix)) out.set(sel.slice(prefix.length), column);
    }
  }
  return out;
}

const sorted = (m: Map<string, string>) => [...m].sort(([a], [b]) => a.localeCompare(b));

describe("the left column moves the same things whichever panel fills it (#1326)", () => {
  it("places the detail panel in the third column under either panel", () => {
    expect(placements("session-list").get(".detail")).toBe("3");
    expect(placements("accounts-panel").get(".detail")).toBe("3");
  });

  it("writes every left-column placement for both panels, with the same column", () => {
    // Non-empty first, so an unparsed file cannot pass as two equal nothings.
    expect(placements("session-list").size).toBeGreaterThanOrEqual(4);
    expect(sorted(placements("accounts-panel"))).toEqual(sorted(placements("session-list")));
  });
});
