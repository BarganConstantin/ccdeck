// #1774. The Projects report's By day chart put its day buttons inside a
// `role="img"`. An image's children are presentational, so the browser prunes
// every button from the accessibility tree — and pruning the tree does nothing
// to the tab order. A screen-reader user tabbing through a 30-day report met
// thirty stops that said nothing: not the date, not the figure, not whether
// the day was the one selected. UsageHistoryModal made this exact mistake and
// fixed it as #381 with `role="group"`; this chart repeated it.
//
// Rendered, not read: the modal is drawn server-side over a seeded 7-day
// report, with the first load already landed (the reducer's initial state is
// the seam) and the portal flattened in place, and the markup it produces is
// what the assertions walk.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Counters } from "../account-projects-reconcile";

const seed = vi.hoisted(() => ({ load: { gen: 0, report: null as unknown, error: null, early: null } }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../account-projects-load", async (orig) => ({ ...(await orig<typeof import("../account-projects-load")>()), INITIAL_LOAD: seed.load }));

const { default: AccountProjectsModal } = await import("../components/AccountProjectsModal");

const MODEL = "claude-opus-4-5-20251101";
const c = (i: number, o: number): Counters => ({ i, o, cr: 0, cc: 0, c1h: 0, c5m: 0 });

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

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

/** Every element carrying `role="img"`, open tag through its matching close. */
function imgElements(html: string): string[] {
  const out: string[] = [];
  const opener = /<(\w+)\b[^>]*\brole="img"[^>]*>/g;
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const tag = m[1];
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    re.lastIndex = m.index + m[0].length;
    let depth = 1, end = html.length;
    for (let t = re.exec(html); t; t = re.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    out.push(html.slice(m.index, end));
  }
  return out;
}

describe("the By day chart lets each day speak (#1774)", () => {
  it("draws the chart, with a pressed-state button for each day", () => {
    const html = render();
    expect(html).toContain('class="ap-proj-days-plot"');
    expect(html.match(/<button[^>]*class="ap-proj-day[ "][^>]*aria-pressed="false"[^>]*aria-label="[^"]+"/g)).toHaveLength(3);
  });

  it("puts no button inside an image", () => {
    const imgs = imgElements(render());
    expect(imgs.length).toBeGreaterThan(0);   // the share bar stays one graphic
    for (const el of imgs) expect(el).not.toContain("<button");
  });

  it("is a group that keeps its name", () => {
    expect(render()).toMatch(/<div class="ap-proj-days-plot" role="group" aria-label="Spend across 3 days">/);
  });
});
