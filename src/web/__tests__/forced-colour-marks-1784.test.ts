// #1784. Under a Windows Contrast theme three surfaces lost the marks that
// carry their meaning. A Contrast theme repaints every background as Canvas,
// and each of these is nothing but a background:
//
//   - the Projects report: the share bar's segments, each row's colour dot and
//     meter fill, and the By day chart's columns, all coloured inline by
//     project. The share bar was left an empty outline and the chart blank,
//     and its day buttons had no edge to find them by;
//   - the session summary's cost legend, whose swatches key the four colours
//     of a cost bar that keeps them (#871), so the bar could not be decoded;
//   - the Accounts panel's live-account dot, which left an empty slot on the
//     one row with no number in it.
//
// #871's block opts marks like these out one selector at a time and never
// named any of them. The report is rendered, the way
// projects-day-chart-group-1774 renders it, so every element it colours
// inline is found from its markup rather than from a list kept here; each
// must then be kept in its own colour by that block. The legend and the dot
// are drawn by the sheet alone, so the sheet is what is read for them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Counters } from "../account-projects-reconcile";
import { sheetText } from "./sheet-source";

const seed = vi.hoisted(() => ({ load: { gen: 0, report: null as unknown, error: null, early: null } }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../account-projects-load", async (orig) => ({ ...(await orig<typeof import("../account-projects-load")>()), INITIAL_LOAD: seed.load }));

const { default: AccountProjectsModal } = await import("../components/AccountProjectsModal");

const MODEL = "claude-opus-4-5-20251101";
const c = (i: number, o: number): Counters => ({ i, o, cr: 0, cc: 0, c1h: 0, c5m: 0 });

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

/** A 7-day report over two projects and three days, its first load landed. */
function render(): string {
  const daily = ["2026-09-20", "2026-09-21", "2026-09-22"].map((day, k) => ({
    day,
    projects: [
      { path: "/u/alpha", models: { [MODEL]: c(1_000 * (k + 1), 20_000) } },
      { path: "/u/beta", models: { [MODEL]: c(500, 10_000 * (k + 1)) } },
    ],
    unattributed: null,
  }));
  const data = { trackedSince: null, days: 7, projects: [], unattributed: null, daily };
  seed.load.report = { gen: 0, days: 7, data, cost: { phase: "failed" } };
  return renderToStaticMarkup(createElement(AccountProjectsModal, { num: 1, name: "a@x.io", onClose: () => {} }));
}

/** Each opening tag's class list, with the inline style it carries. */
function tags(html: string): Array<{ tag: string; cls: string[]; style: string }> {
  return [...html.matchAll(/<(\w+)\b([^>]*)>/g)].map(m => ({
    tag: m[1],
    cls: (/\bclass="([^"]*)"/.exec(m[2])?.[1] ?? "").split(/\s+/).filter(Boolean),
    style: /\bstyle="([^"]*)"/.exec(m[2])?.[1] ?? "",
  }));
}

// The one forced-colours block, as forced-colors-871.test.ts reads it.
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const OPEN = "@media (forced-colors: active) {";
const start = css.indexOf(OPEN);
const block = (() => {
  let depth = 0;
  for (let i = start + OPEN.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start + OPEN.length, i);
  }
  return "";
})();
const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean),
  body: m[2],
}));
const bodyOf = (sel: string) => rules.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");
const opts = (sel: string) => /forced-color-adjust:\s*none/.test(bodyOf(sel));
const background = (sel: string) => /background:\s*([A-Za-z]+)\s*;/.exec(bodyOf(sel))?.[1];

describe("the Projects report under a Contrast theme (#1784)", () => {
  let html = "";
  beforeAll(() => { html = render(); });

  it("keeps every mark it colours by project in that project's colour", () => {
    const inked = new Set(tags(html).filter(t => /\bbackground\s*:/.test(t.style)).flatMap(t => t.cls));
    // The share bar's segments, each row's dot and fill, and the day columns.
    expect([...inked].sort()).toEqual(["ap-proj-colseg", "ap-proj-dot", "ap-proj-fill", "ap-proj-seg"]);
    for (const cls of inked) {
      expect(opts(`.${cls}`), `.${cls} opts out`).toBe(true);
      expect(bodyOf(`.${cls}`), `.${cls} keeps its own colour`).not.toMatch(/background/);
    }
  });

  it("outlines the share bar and each row's track, so a fill is still a share of something", () => {
    for (const rail of [".ap-proj-bar", ".ap-proj-track"]) {
      expect(bodyOf(rail), rail).toMatch(/outline:\s*1px solid CanvasText/);
    }
  });

  it("gives each day of the chart an edge to find it by, and the chosen day a ring", () => {
    const days = tags(html).filter(t => t.tag === "button" && t.cls.includes("ap-proj-day"));
    expect(days).toHaveLength(3);
    expect(bodyOf(".ap-proj-day")).toMatch(/outline:\s*1px solid ButtonBorder/);
    // The accent ring a chosen day wears is a shadow, and a Contrast theme
    // drops shadows: it comes back in the highlight, as an outline, since the
    // shadow's own rule comes later in the sheet than this block and would
    // take a shadow back.
    const chosen = ".ap-proj-day.selected .ap-proj-col";
    expect(bodyOf(chosen)).toMatch(/outline:\s*2px solid Highlight/);
    expect(bodyOf(chosen)).not.toMatch(/box-shadow/);
  });
});

describe("the session summary's cost legend under a Contrast theme (#1784)", () => {
  it("keeps each swatch in the colour it keys, as the bar it keys keeps its own", () => {
    expect(opts(".cost-bar .cb-seg")).toBe(true);
    for (const part of ["in", "out", "cr", "cw"]) {
      const swatch = `.session-summary .ssl-${part}::before`;
      // The swatch's colour is its own rule's; the box every swatch shares is
      // drawn by `.ssl::before`, and either may carry the opt-out.
      expect(css, swatch).toMatch(new RegExp(`${swatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{\\s*background:\\s*var\\(--usage-`));
      const drawnBy = [swatch, ".session-summary .ssl::before"];
      expect(drawnBy.some(opts), `${swatch} opts out`).toBe(true);
      for (const sel of drawnBy) expect(bodyOf(sel), sel).not.toMatch(/background/);
    }
  });
});

describe("the Accounts panel's live account under a Contrast theme (#1784)", () => {
  it("draws its dot in the highlight, as every other live mark is", () => {
    expect(opts(".ap-live::before")).toBe(true);
    expect(background(".ap-live::before")).toBe("Highlight");
  });
});
