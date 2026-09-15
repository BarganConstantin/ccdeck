// #856: explanations that decide an action lived only in title tooltips. A
// keyboard or touch reader never sees a title, and screen readers announce them
// unevenly.
//
// Two of them decide something. Why a login died decides whether to sign in
// again, and "stay near N% by now" decides whether to slow down. Both are now a
// button that opens the explanation as text in place. The rest — the card's
// cost breakdown, where a quota reading came from — decide nothing and keep
// their titles, which is what the issue asked for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const accounts = read("../components/AccountsPanel.tsx");
const usage = read("../components/UsagePanel.tsx");
const node = read("../components/AgentNode.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Bodies of every rule whose selector list names exactly this selector. */
function decl(selector: string, prop: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").map(s => s.trim()).includes(selector)) continue;
    const d = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) return d[1].trim();
  }
  return null;
}

// The accounts half has moved once since: the reason no longer opens as a line
// that pushes the row down, but as a popover over the column hung from the
// warning — the ⋯ menu's surface — with the fix as its one button.
describe("why a login failed is a button, not a title (#856)", () => {
  const warning = /<button type="button" id=\{`ap-issue-\$\{a\.num\}`\}[\s\S]*?<\/button>/.exec(accounts)?.[0] ?? null;

  it("is a button that says whether its reason is open", () => {
    expect(warning, "the warning is not a button").not.toBeNull();
    expect(warning).toMatch(/aria-haspopup="dialog"/);
    expect(warning).toMatch(/aria-expanded=\{issueOpen\?\.anchor === `ap-issue-\$\{a\.num\}`\}/);
    // Conditional, because the target only exists while it is open — the same
    // rule the ⋯ menu follows.
    expect(warning).toMatch(/aria-controls=\{issueOpen\?\.anchor === `ap-issue-\$\{a\.num\}` \? "ap-issue-pop" : undefined\}/);
  });

  it("opens the reason as text over the column, and never as a title", () => {
    expect(accounts).not.toMatch(/className="ap-issue"[^>]*\stitle=/);
    expect(accounts).toMatch(/<p className="ap-pop-note ap-issue-hint">\{issue\.hint\}<\/p>/);
    expect(accounts).toMatch(/role="dialog"\s*labelledBy="ap-issue-title"/);
  });

  it("draws the failure as a mark and a word in the warning ink, with a 24px target", () => {
    expect(decl('.ap-issue[data-tone="warn"]', "color")).toBe("var(--warn)");
    expect(decl(".ap-issue", "position")).toBe("relative");
    expect(decl(".ap-issue::after", "height")).toBe("24px");
  });
});

describe("the pace note opens the number it is measured against (#856)", () => {
  const note = /<button[\s\S]*?className="qb-pace"[\s\S]*?<\/button>/.exec(usage)?.[0] ?? null;

  it("is a button that says whether its explanation is open", () => {
    expect(note, "the pace note is not a button").not.toBeNull();
    expect(note).toMatch(/aria-expanded=\{why\}/);
    expect(note).toMatch(/aria-controls=\{why \? whyId : undefined\}/);
  });

  it("says the number on screen when open, which was a title on a 2px tick", () => {
    expect(usage).toMatch(/<div id=\{whyId\} className="qb-why">\s*To last until reset, stay near \{Math\.round\(pace\.expectedPct\)\}% by now\.\s*<\/div>/);
  });

  it("keeps the 11px the note set, and a 24px target", () => {
    expect(decl("button.qb-pace", "font"), "a font shorthand would reset .qb-pace's 11px").toBeNull();
    expect(decl(".qb-pace", "font-size")).toBe("11px");
    expect(decl("button.qb-pace::after", "height")).toBe("24px");
  });
});

describe("what stays a title, because it decides nothing (#856)", () => {
  it("keeps the card's cost breakdown a title", () => {
    expect(node).toMatch(/<span className="cost-meta" title=\{tt\}>/);
  });

  it("keeps where a quota reading came from a title", () => {
    expect(usage).toMatch(/className="up-section-age" title=\{quotaSourceHint\(quota\?\.source\)\}/);
  });
});
