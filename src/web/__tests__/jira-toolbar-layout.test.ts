// Resolve the toolbar's real CSS at panel widths, independently of viewport.
// Native browser QA checks geometry and the scroller's mouse/keyboard reach.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { declared, el, mediaApplies, selects, splitTop, type El } from "./sheet-cascade";

const css = readFileSync(new URL("../styles/jira.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules: Array<{ selectors: string[]; body: string; max: number; media: string | null }> = [];
function read(text: string, max = Infinity, media: string | null = null) {
  let from = 0;
  while (from < text.length) {
    const open = text.indexOf("{", from);
    if (open < 0) break;
    let end = open + 1, depth = 1;
    while (end < text.length && depth) { if (text[end] === "{") depth++; if (text[end] === "}") depth--; end++; }
    const head = text.slice(from, open).trim(), body = text.slice(open + 1, end - 1);
    const container = /^@container jira-panel \(max-width: (\d+)px\)$/.exec(head);
    if (container) read(body, Math.min(max, Number(container[1])), media);
    else if (head.startsWith("@media ")) read(body, max, head.slice(7));
    else if (!head.startsWith("@")) rules.push({ selectors: splitTop(head), body, max, media });
    from = end;
  }
}
read(css);
const panel = [el("div", ["jr-panel"])];
const toolbar = [...panel, el("div", ["jr-toolbar"])];
const filters = [...toolbar, el("div", ["jr-filters"])];
const chips = [...filters, el("div", ["jr-filter-chips"])];
function value(chain: El[], property: string, panelWidth: number, viewport = 1784) {
  let best: { value: string; spec: number; order: number } | undefined;
  rules.forEach((r, order) => {
    if (panelWidth > r.max || !mediaApplies(r.media, viewport)) return;
    const v = declared(r.body, property);
    if (v == null) return;
    for (const selector of r.selectors) {
      const spec = selects(selector, chain);
      if (spec != null && (!best || spec > best.spec || (spec === best.spec && order > best.order))) best = { value: v, spec, order };
    }
  });
  return best?.value ?? null;
}

describe("compact Jira toolbar", () => {
  for (const width of [701, 1000, 1440, 1784]) it(`${width}px panel shares one desktop line without reserving picker width`, () => {
    expect(value(toolbar, "display", width)).toBe("flex");
    expect(value(toolbar, "flex-direction", width)).toBeNull();
    const board = [...toolbar, el("span", ["jr-board-layer"])];
    expect(value(board, "width", width)).toBe("auto");
    expect(value(board, "max-width", width)).toBe("200px");
    expect(value(board, "--jr-pop-w", width)).toBe("min(360px, calc(100vw - 32px))");
    expect(value(filters, "flex", width)).toBe("1");
    expect(value([...filters, el("div", ["ig-search"])], "min-width", width)).toBe("140px");
  });
  for (const width of [320, 390, 560, 700]) it(`${width}px panel stacks search/chips even inside a wide viewport`, () => {
    expect(value(toolbar, "display", width)).toBe("grid");
    expect(value(filters, "grid-column", width)).toBe("1 / -1");
    expect(value(filters, "grid-row", width)).toBe("2");
    expect(value([...filters, el("div", ["ig-search"])], "flex", width)).toBe("1 1 100%");
    expect(value(chips, "flex", width)).toBe("1 1 100%");
  });
  for (const width of [320, 390, 700, 1440]) it(`${width}px keeps overflow chips reachable and freshness words visible`, () => {
    expect(value(chips, "overflow-x", width)).toBe("auto");
    expect(value(chips, "scrollbar-width", width)).toBe("thin");
    expect(value(chips, "padding", width)).toBe("3px");
    expect(value([...chips, el("button", ["btn", "jr-chip"])], "flex", width)).toBe("none");
    const fresh = [...toolbar, el("div", ["ig-freshness"]), el("span", ["ig-fresh"])];
    expect(value(fresh, "white-space", width)).toBe("normal");
    expect(value(fresh, "overflow", width)).toBe("visible");
    expect(value([...panel, el("div", ["jr-toolbar"], { attrs: { hidden: "" } })], "display", width)).toBe("none");
  });
});


describe("Jira group header hierarchy", () => {
  const head = [...panel, el("section", ["jr-group"]), el("div", ["jr-group-head"])];
  for (const width of [249, 320, 390, 700, 1440]) it(`${width}px header allows totals to wrap and aligns secondary facts with the name`, () => {
    const totals = [...head, el("div", ["jr-group-totals"])];
    const facts = [...head, el("div", ["jr-group-facts"])];
    expect(value(head, "flex-wrap", width)).toBe("wrap");
    expect(value([...head, el("h3", ["jr-group-title"])], "flex", width)).toBe("1 1 240px");
    expect(value(totals, "max-width", width)).toBe("100%");
    expect(value([...head, el("div", ["jr-group-totals"], { states: ["empty"] })], "display", width)).toBe("none");
    expect(value(facts, "flex", width)).toBe("1 1 100%");
    expect(value(facts, "padding-left", width)).toBe("26px");
    expect(value(facts, "flex-wrap", width)).toBe("wrap");
    expect(value([...facts, el("span", ["jr-group-dates"])], "white-space", width)).toBe("normal");
    expect(value([...facts, el("span", ["jr-group-dates"])], "overflow-wrap", width)).toBe("anywhere");
  });
  it("retains discreet filter edges and makes pressed filters distinct", () => {
    const chip = [...chips, el("button", ["btn", "jr-chip"], { attrs: { "aria-pressed": "true" } })];
    expect(value(chip, "font-weight", 1440)).toBe("600");
    expect(value(chip, "border-color", 1440)).toBe("var(--accent)");
    expect(value(chip, "padding-inline", 1440)).toBe("8px");
  });
});


describe("long sprint identity keeps its chevron on the first line", () => {
  for (const width of [249, 320, 390, 700, 1440]) it(`${width}px wraps the identity inside a nonwrapping toggle`, () => {
    const toggle = [...panel, el("div", ["jr-group-head"]), el("h3", ["jr-group-title"]), el("button", ["jr-group-toggle"])];
    const identity = [...toggle, el("span", ["jr-group-identity"])];
    expect(value(toggle, "flex-wrap", width)).toBe("nowrap");
    expect(value(toggle, "align-items", width)).toBe("flex-start");
    expect(value([...toggle, el("svg", ["jr-chevron"])], "margin-top", width)).toBe("3px");
    expect(value(identity, "flex", width)).toBe("1");
    expect(value(identity, "min-width", width)).toBe("0");
    expect(value(identity, "flex-wrap", width)).toBe("wrap");
    expect(value([...identity, el("span", ["jr-group-name"])], "max-width", width)).toBe("100%");
    expect(value([...identity, el("span", ["jr-group-name"])], "overflow-wrap", width)).toBe("anywhere");
  });
});
