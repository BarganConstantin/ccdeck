// The Usage panel as V4's Figma draws it: the box, one
// close in the header with the other two controls moved, the period chips, the
// hero, the tokens row, the quota rows and the meter rule, and the By model /
// By session rows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quotaMeterColor } from "../components/QuotaBar";
import { sheetText } from "./sheet-source";
import { en } from "../i18n/en";
import { WEB_DIR } from "./client-source";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
function parse(text: string): Rule[] {
  const out: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) { /* not read here */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? prelude.slice(6).trim() : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        out.push({ media, selectors: prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return out;
}
const rules = parse(css);
function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
// CHANGED ON PURPOSE (light-theme review): a line height grows with the
// reader's text size as the size does, as V4's type roles say a reader's
// increase is added to both (tokens.css). At Largest a 16px word sat in a 16px
// line and two lines of a note touched; at Default nothing moves.
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;
const panel = readFileSync(join(WEB_DIR, "components/UsagePanel.tsx"), "utf8");
const header = /<div className="up-header"[\s\S]*?<div className="up-body">/.exec(panel)![0];

describe("the box", () => {
  it("is 320 wide, --panel, a 1px --line-soft edge, --r-node and the overlay shadow", () => {
    expect(decl(".usage-panel", "width")).toBe("calc(320px + var(--ui-panel-increase, 0px))");
    expect(decl(".usage-panel", "background")).toBe("var(--panel)");
    expect(decl(".usage-panel", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".usage-panel", "border-radius")).toBe("var(--r-node)");
    expect(decl(".usage-panel", "box-shadow")).toBe("var(--shadow-overlay)");
  });
  it("pads the body 12 with a gap of 12", () => {
    expect(decl(".up-body", "padding")).toBe("12px");
    expect(decl(".up-body", "gap")).toBe("12px");
  });
});

describe("the header", () => {
  it("is 36 tall, a 1px --line under it, padding 0 4 0 12, gap 6; 'Usage' 600 13/20 --text", () => {
    expect(decl(".up-header", "height")).toBe("var(--pane-head-h)");
    expect(decl(".up-header", "border-bottom")).toBe("1px solid var(--line)");
    expect(decl(".up-header", "padding")).toBe("0 4px 0 12px");
    expect(decl(".up-header", "gap")).toBe("6px");
    expect(decl(".usage-panel .up-header h2", "font-size")).toBe(INC(13));
    expect(decl(".usage-panel .up-header h2", "line-height")).toBe(INC(20));
    expect(decl(".usage-panel .up-header h2", "font-weight")).toBe("600");
    expect(decl(".usage-panel .up-header h2", "color")).toBe("var(--text)");
  });
  it("holds ONE button, the close, as a plain glyph-btn with the kit's close and no radius of its own", () => {
    expect(header.match(/<button/g)).toHaveLength(1);
    expect(header).toContain('className="glyph-btn up-close"');
    expect(header).toContain('<KitIcon name="close" />');
    expect(decl(".up-close", "border-radius")).toBeUndefined();
  });
  it("moved the refresh and the quota history to the foot of the body, both still pressable", () => {
    const foot = panel.slice(panel.indexOf('<div className="up-acts">'));
    expect(foot).toContain("onClick={refreshAll}");
    expect(foot).toContain("setQuotaHistoryOpen(");
    // CHANGED ON PURPOSE (the UI in every language): both words are read through their keys.
    // The visible label, not the button's title: the markup after the icon.
    expect(foot).toMatch(/<KitIcon name="update" className="refresh-glyph" \/>\{t\("usage\.refreshWord"\)\}\s*<\/button>/);
    expect(foot).toMatch(/<KitIcon name="history" \/>\{t\("usage\.history"\)\}\s*<\/button>/);
    expect(en["usage.refreshWord"]).toBe("Refresh");
    expect(en["usage.history"]).toBe("Quota history");
    expect(decl(".up-quiet", "height")).toBe("24px");
  });
});

describe("the period chips", () => {
  it("are 24 high, --r-pill, padding 0 8, a 1px stroke, 400 12/16; the chosen one --accent-16 with an --accent stroke and --text", () => {
    expect(decl(".up-period .uh-range-btn", "height")).toBe("24px");
    expect(decl(".up-period .uh-range-btn", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".up-period .uh-range-btn", "padding")).toBe("0 8px");
    expect(decl(".up-period .uh-range-btn", "border")).toBe("1px solid var(--line)");
    expect(decl(".up-period .uh-range-btn", "font-size")).toBe(INC(12));
    expect(decl(".up-period .uh-range-btn", "line-height")).toBe(INC(16));
    expect(decl(".up-period .uh-range-btn", "color")).toBe("var(--text-secondary)");
    expect(decl('.up-period .uh-range-btn[aria-pressed="true"]', "background")).toBe("var(--accent-16)");
    expect(decl('.up-period .uh-range-btn[aria-pressed="true"]', "border-color")).toBe("var(--accent)");
    expect(decl('.up-period .uh-range-btn[aria-pressed="true"]', "color")).toBe("var(--text)");
  });
  it("sit in a row with a gap of 4", () => {
    expect(decl(".uh-range.up-period", "gap")).toBe("4px");
  });
});

describe("the hero and the tokens", () => {
  it("sets the figure mono 600 22/28 --text and the words 400 12/16 --muted", () => {
    expect(decl(".up-total-value", "font-family")).toBe("var(--font-mono)");
    expect(decl(".up-total-value", "font-size")).toBe(INC(22));
    expect(decl(".up-total-value", "line-height")).toBe(INC(28));
    expect(decl(".up-total-value", "font-weight")).toBe("600");
    expect(decl(".up-total-value", "color")).toBe("var(--text)");
    expect(decl(".up-total-label", "font-size")).toBe(INC(12));
    expect(decl(".up-total-label", "color")).toBe("var(--muted)");
  });
  it("sets the tokens row with a gap of 16, values mono 12/16 --text and captions 11/14 --muted", () => {
    expect(decl(".up-tokens-row", "gap")).toBe("4px 16px");
    expect(decl(".up-tok", "font-family")).toBe("var(--font-mono)");
    expect(decl(".up-tok", "font-size")).toBe(INC(12));
    expect(decl(".up-tok", "color")).toBe("var(--text)");
    expect(decl(".up-k", "font-size")).toBe(INC(11));
    expect(decl(".up-k", "line-height")).toBe(INC(14));
    expect(decl(".up-k", "color")).toBe("var(--muted)");
  });
  it("shows quotas before the period spend and its breakdown", () => {
    const order = ["<ClaudeQuotaSection", "<CodexQuotaSection", "<UsagePeriodStrip", 'className="up-total"', 'className="up-tokens-row"', "<UsageModelTable", "<UsageSessionBreakdown"]
      .map(s => panel.indexOf(s));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the quota sections", () => {
  it("sets a title 600 12/16 --text-secondary in a 16-high row, in the case it is written in; the plan and age mono 11/14 --muted", () => {
    expect(decl(".up-section-title", "font-size")).toBe(INC(12));
    expect(decl(".up-section-title", "line-height")).toBe(INC(16));
    expect(decl(".up-section-title", "min-height")).toBe("16px");
    expect(decl(".up-section-title", "font-weight")).toBe("600");
    expect(decl(".up-section-title", "color")).toBe("var(--text-secondary)");
    expect(decl(".up-section-title", "text-transform")).toBe("none");
    expect(decl(".up-section-title", "letter-spacing")).toBe("0");
    for (const sel of [".up-plan-badge", ".up-section-age"]) {
      expect(decl(sel, "font-family")).toBe("var(--font-mono)");
      expect(decl(sel, "font-size")).toBe(INC(11));
      expect(decl(sel, "line-height")).toBe(INC(14));
      expect(decl(sel, "color")).toBe("var(--muted)");
    }
  });
  it("sets a window: rows 3 apart, the name 400 12/16 --text-secondary, the percent mono 12/16 --text, the meter 2 high on --ctl-fill", () => {
    expect(decl(".qb-row", "gap")).toBe("3px");
    expect(decl(".qb-label", "color")).toBe("var(--text-secondary)");
    expect(decl(".qb-label", "font-weight")).toBe("400");
    expect(decl(".qb-pct", "font-family")).toBe("var(--font-mono)");
    expect(decl(".qb-pct", "font-size")).toBe(INC(12));
    expect(decl(".qb-pct[data-known]", "color")).toBe("var(--text)");
    expect(decl(".qb-track", "height")).toBe("2px");
    expect(decl(".qb-track", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".qb-track", "background")).toBe("var(--ctl-fill)");
  });
  it("sets the line under the meter 400 12/16 --muted and its note mono 11/14 --muted; footnotes 12/16 --muted", () => {
    expect(decl(".qb-reset", "font-size")).toBe(INC(12));
    expect(decl(".qb-reset", "color")).toBe("var(--muted)");
    expect(decl(".qb-pace", "font-family")).toBe("var(--font-mono)");
    expect(decl(".qb-pace", "font-size")).toBe(INC(11));
    expect(decl(".qb-pace", "color")).toBe("var(--muted)");
    expect(decl(".up-quota-sub", "font-size")).toBe(INC(12));
    expect(decl(".up-quota-sub", "color")).toBe("var(--muted)");
  });
  it("uses the main meter colours: accent, warning and error", () => {
    expect(quotaMeterColor(0)).toBe("var(--accent)");
    expect(quotaMeterColor(69.9)).toBe("var(--accent)");
    expect(quotaMeterColor(70)).toBe("var(--warn)");
    expect(quotaMeterColor(89)).toBe("var(--warn)");
    expect(quotaMeterColor(90)).toBe("var(--err)");
    expect(quotaMeterColor(10, true)).toBe("var(--err)");
    expect(readFileSync(join(WEB_DIR, "components/QuotaBar.tsx"), "utf8")).toContain("const color    = quotaMeterColor(capped, isErr);");
  });
});

describe("By model and By session", () => {
  it("sets the label row 20 high, rows 24 high two apart, the name 400 12/16 --text-secondary, tokens mono 12/16 --muted, cost mono 12/16 --text", () => {
    expect(decl(".up-section:not(.up-quota-section) .up-section-title", "min-height")).toBe("20px");
    expect(decl(".up-table", "border-spacing")).toBe("0 2px");
    expect(decl(".up-table td", "height")).toBe("24px");
    expect(decl(".up-model-name", "color")).toBe("var(--text-secondary)");
    expect(decl(".up-model-name", "font-weight")).toBe("400");
    expect(decl(".up-num", "font-size")).toBe(INC(12));
    expect(decl(".up-num", "color")).toBe("var(--muted)");
    expect(decl(".up-cost-val", "color")).toBe("var(--text)");
    expect(decl(".up-session-row", "height")).toBe("24px");
    expect(decl(".up-session-label", "color")).toBe("var(--text-secondary)");
    expect(decl(".up-session-tokens", "font-size")).toBe(INC(12));
    expect(decl(".up-session-cost", "color")).toBe("var(--text)");
  });
  it("keeps 'not priced' --muted", () => {
    expect(decl(".up-unpriced", "color")).toBe("var(--muted)");
  });
  it("sets the 'active today' part mono 11/14 --muted", () => {
    expect(decl(".up-section-age", "font-family")).toBe("var(--font-mono)");
    expect(decl(".up-section-age", "color")).toBe("var(--muted)");
  });
});
