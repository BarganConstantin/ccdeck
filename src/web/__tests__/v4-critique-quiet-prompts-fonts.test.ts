// The owner's V4 critique of 2026-11-10, points 5 and 8.
//
// 5. A background task's notice in the Inspector's Prompts list wore a thick
//    dashed edge: a bare `border-style: dashed`, so 3px in currentColor once V4
//    took the box off a prompt. It read as a drop zone and was the loudest row
//    in the panel while being the least important. It is the quietest row now,
//    told from a typed prompt by its muted step, not by a decoration.
// 8. Segmented controls in two faces: the shared .uh-range-btn was mono, so
//    "All agents | Claude | Codex" and "Most used | Latest | Name" did not match
//    "24 hours | 7 days". Every segmented control is the interface's sans; mono
//    is for figures and ids. And "cache r" / "cache c" are words now, in every
//    language, in the insights area's own wording.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { LANGUAGES } from "../i18n/registry";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { costBreakdownTooltip } from "../card-cost";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** Every rule in the sheet, media blocks included: its selector list and body. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ selectors: m[1].trim().split(",").map(s => s.trim().replace(/\s+/g, " ")), body: m[2] }));

/** The rules whose selector list holds exactly `selector`. */
const rulesFor = (selector: string) => rules.filter(r => r.selectors.includes(selector));

/** Does `selector`'s subject (its last compound) carry `cls`? */
const subjectHas = (selector: string, cls: string) =>
  new RegExp(`\\.${cls}(?![\\w-])`).test(selector.split(/\s*[\s>+~]\s*/).pop() ?? "");

describe("an automatic prompt is the quietest row in the Prompts list (point 5)", () => {
  it("draws no dashed edge, nor any edge or fill of its own", () => {
    const own = rules.filter(r => r.selectors.some(s => /\.prompt-(?:injected|entry)(?![\w-])/.test(s)));
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r.body, r.selectors.join(", ")).not.toMatch(/dashed/);
    const [base] = rulesFor(".prompt-injected");
    expect(base.body).toMatch(/(?:^|[;\s])border:\s*0;/);
    expect(base.body).toMatch(/(?:^|[;\s])background:\s*none;/);
    expect(base.body).toMatch(/(?:^|[;\s])padding:\s*0;/);
  });

  it("is told from a typed prompt by a quieter step, not a decoration", () => {
    const label = rulesFor(".prompt-injected-label")[0].body;
    const typed = rulesFor(".prompt-text")[0].body;
    expect(label).toMatch(/color:\s*var\(--muted\)/);
    expect(typed).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(label).toMatch(/font-size:\s*calc\(11px/);
    expect(typed).toMatch(/font-size:\s*calc\(12px/);
  });
});

describe("every segmented control is set in the interface's sans (point 8)", () => {
  // The buttons of the deck's segmented strips and tab-like toggles, and the
  // forge row's order toggle and which-ones menu that stand in for its strip.
  const SEGMENT_BUTTONS = ["uh-range-btn", "ta-period-btn", "ap-side", "tr-tab", "aa-tab", "fgl-sort", "fgl-scope-trigger"];

  it("never gives a segment button the mono face", () => {
    for (const cls of SEGMENT_BUTTONS) {
      for (const r of rules.filter(rule => rule.selectors.some(s => subjectHas(s, cls)))) {
        expect(r.body, `${r.selectors.join(", ")} sets ${cls} in mono`).not.toMatch(/font-mono/);
      }
    }
  });

  it("takes the shared strip's face from the page and keeps its size", () => {
    const [base] = rulesFor(".uh-range-btn");
    expect(base.body).toMatch(/(?:^|[;\s])font:\s*inherit;/);
    expect(base.body).not.toMatch(/font-family/);
    expect(base.body).toMatch(/font-size:\s*calc\(11px \+ var\(--ui-text-increase, 0px\)\)/);
  });

  it("draws the three strips the owner named with the shared classes the rule covers", () => {
    const audit = read("components/ToolAuditModal.tsx");
    const skills = read("components/SkillActivity.tsx");
    expect(audit).toMatch(/aria-label=\{t\('insights\.audit\.agent'\)\}>\{providers\.map\(item => <button[^>]*className="uh-range-btn"/);
    expect(audit).toMatch(/className="ta-period-btn"/);
    expect(skills).toMatch(/className="uh-range ta-sorts sa-sorts"[^>]*>\{skillSorts\.map\(item => <button[^>]*className="uh-range-btn"/);
  });
});

describe("cache read and cache write are words in every language (point 8)", () => {
  afterEach(() => { setLanguage("en"); resetLanguageForTest(); });

  const READS = ["board.tokens.cacheR", "board.cost.cacheR", "usage.tokens.cacheRead", "insights.summary.cacheR"] as const;
  const WRITES = ["board.tokens.cacheC", "board.cost.cacheW", "usage.tokens.cacheCreate", "insights.summary.cacheW"] as const;

  it("leaves no cache r, cache c or cache w anywhere, nor a clipped word after cache", () => {
    // "cache r", "cache-c:", "Cache-R", "cache w5m", "caché e1h"; and "cache cit.",
    // "Cache gel.", "caché escr." — a letter or a stub where a word belongs.
    const LETTER = /\bcach[eé][- ]\p{L}(?:\d+[mh])?(?![\p{L}\d])/iu;
    const STUB = /\bcach[eé][- ]\p{L}{1,5}\./iu;
    for (const { code, catalog } of LANGUAGES) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, `${code} ${key}`).not.toMatch(LETTER);
        expect(value, `${code} ${key}`).not.toMatch(STUB);
      }
    }
  });

  it("says them as the insights area does, in each language", () => {
    for (const { code, catalog } of LANGUAGES) {
      for (const key of READS) expect(catalog[key], `${code} ${key}`).toBe(catalog["insights.cost.cacheRead"]);
      for (const key of WRITES) expect(catalog[key], `${code} ${key}`).toBe(catalog["insights.cost.cacheWrite"]);
    }
    const en = LANGUAGES[0].catalog;
    expect([en["board.tokens.cacheR"], en["board.tokens.cacheC"]]).toEqual(["cache read", "cache write"]);
    expect(en["board.meta.tokensTitle"]).toBe("in: {input}  out: {output}  cache read: {cacheR}  cache write: {cacheC}");
  });

  it("keeps the text tooltip's × in one column with the longer labels, in every language", () => {
    const usage = {
      inputTokens: 1_204, outputTokens: 33_120, cacheReadTokens: 4_400_000,
      cacheCreateTokens: 120_000, cacheCreate1hTokens: 80_000, cacheCreate5mTokens: 40_000,
    };
    for (const { code } of LANGUAGES) {
      setLanguage(code);
      const lines = costBreakdownTooltip(usage, "claude-sonnet-5").split("\n").filter(l => l.includes("×"));
      expect(lines.length, code).toBe(5);
      expect(new Set(lines.map(l => l.indexOf("×"))).size, code).toBe(1);
    }
  });

  it("lets a spelled-out label wrap in the 320-wide cost tip, never the sum beside it", () => {
    const label = rulesFor(".cost-tip-label")[0].body;
    const value = rulesFor(".cost-tip-value")[0].body;
    expect(label).not.toMatch(/white-space:\s*nowrap/);
    expect(label).toMatch(/min-width:\s*0/);
    expect(value).toMatch(/white-space:\s*nowrap/);
    expect(value).toMatch(/flex:\s*none/);
  });
});
