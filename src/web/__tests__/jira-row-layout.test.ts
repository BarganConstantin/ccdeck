// Row-content layout contracts, resolved against the real Jira stylesheet.
// These ask which rules win at the list's width, including the rich-row
// attribute and phone overrides; browser geometry is validated by native QA.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { declared, el, mediaApplies, selects, splitTop, type El } from "./sheet-cascade";

const source = readFileSync(new URL("../styles/jira.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
type Rule = { selectors: string[]; body: string; max: number | null; media: string | null };
const rules: Rule[] = [];
function read(text: string, max: number | null = null, media: string | null = null) {
  let from = 0;
  while (from < text.length) {
    const open = text.indexOf("{", from);
    if (open < 0) break;
    let end = open + 1, depth = 1;
    while (end < text.length && depth) { if (text[end] === "{") depth++; if (text[end] === "}") depth--; end++; }
    const head = text.slice(from, open).trim(), body = text.slice(open + 1, end - 1);
    const container = /^@container jira-list \(max-width: (\d+)px\)$/.exec(head);
    if (container) read(body, Math.min(max ?? Infinity, Number(container[1])), media);
    else if (head.startsWith("@media ")) read(body, max, head.slice(7));
    else if (!head.startsWith("@")) rules.push({ selectors: splitTop(head), body, max, media });
    from = end;
  }
}
read(source);
const chain = (rich: boolean, tail: El[] = []) => [el("div", ["jr-list-scroll"]), el("div", ["jr-row"]),
  el("button", ["jr-row-main"], { attrs: rich ? { "data-has-meta": "true" } : {} }), ...tail];
function value(chain: El[], property: string, width: number) {
  let best: { value: string; spec: number; order: number } | undefined;
  rules.forEach((rule, order) => {
    if ((rule.max != null && width > rule.max) || !mediaApplies(rule.media, 1440)) return;
    const v = declared(rule.body, property);
    if (v == null) return;
    for (const selector of rule.selectors) {
      const spec = selects(selector, chain);
      if (spec != null && (!best || spec > best.spec || (spec === best.spec && order > best.order))) best = { value: v, spec, order };
    }
  });
  return best?.value ?? null;
}
const facts = [el("span", ["jr-facts"])];
const meta = [...facts, el("span", ["jr-meta"])];
const status = [...facts, el("span", ["jr-status-cell"])];
const estimate = [...facts, el("span", ["jr-estimate", "ig-chip"])];

describe("Jira rich and plain row-content layouts", () => {
  for (const width of [561, 600, 719, 720, 721, 800, 1200, 1600]) {
    it(`a ${width}px list reserves the rich row's first line for identity and keeps plain rows compact`, () => {
      expect(value(chain(true), "grid-template-columns", width)).toBe("16px 16px auto minmax(0, 1fr) 20px");
      expect(value(chain(true, facts), "grid-row", width)).toBe("2");
      expect(value(chain(true, facts), "grid-column", width)).toBe("3 / -1");
      expect(value(chain(true, [el("span", ["jr-assignee"])]), "grid-row", width)).toBe("1");
      expect(value(chain(false), "grid-template-columns", width)).toBe("16px 16px auto minmax(16ch, 1fr) minmax(0, max-content) 20px");
      expect(value(chain(false, facts), "grid-row", width)).toBeNull();
    });
  }
  for (const width of [361, 390, 480, 560]) for (const rich of [false, true]) {
    it(`${rich ? "rich" : "plain"} rows at ${width}px place status first on one bounded facts line`, () => {
      expect(value(chain(rich), "grid-template-columns", width)).toBe("16px 16px auto minmax(0, 1fr) 20px");
      expect(value(chain(rich, facts), "grid-row", width)).toBe("2");
      expect(value(chain(rich, facts), "flex-wrap", width)).toBe("nowrap");
      expect(value(chain(rich, meta), "flex-wrap", width)).toBe("nowrap");
      expect(value(chain(rich, meta), "flex", width)).toBe("1");
      expect(value(chain(rich, meta), "overflow", width)).toBe("hidden");
      expect(value(chain(rich, status), "order", width)).toBe("-1");
      expect(value(chain(rich, estimate), "flex", width)).toBe("none");
    });
  }
  for (const width of [249, 280, 320, 360]) for (const rich of [false, true]) {
    it(`${rich ? "rich" : "plain"} rows at ${width}px retain the phone's status/title/metadata placement`, () => {
      expect(value(chain(rich), "grid-template-columns", width)).toBe("16px 16px minmax(0, max-content) minmax(0, 1fr) 20px");
      expect(value(chain(rich, facts), "display", width)).toBe("contents");
      expect(value(chain(rich, status), "grid-row", width)).toBe("1");
      const summary = chain(rich, [el("span", ["jr-summary"])]);
      expect(value(summary, "grid-row", width)).toBe("2");
      expect(value(summary, "-webkit-line-clamp", width)).toBe("2");
      expect(value(chain(rich, meta), "grid-row", width)).toBe("3");
      expect(value(chain(rich, estimate), "grid-row", width)).toBe("3");
      expect(value(chain(rich, meta), "overflow", width)).toBe("hidden");
    });
  }
  it("rich metadata never wraps even in a wide full-width list", () => {
    for (const width of [600, 720, 721, 1200, 1600]) {
      expect(value(chain(true, facts), "flex-wrap", width)).toBe("nowrap");
      expect(value(chain(true, meta), "flex-wrap", width)).toBe("nowrap");
      expect(value(chain(true, meta), "flex", width)).toBe("1");
      expect(value(chain(true, estimate), "flex", width)).toBe("none");
    }
  });
});
