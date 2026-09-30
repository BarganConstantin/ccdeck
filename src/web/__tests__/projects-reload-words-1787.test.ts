// #1787. A Projects report switching windows keeps the last report up until
// the next one lands, and it used to say so by dropping every child of its
// body to 0.55 opacity: --muted fell to 2.29:1 in dark and even --text to
// 4.18:1 in light, for as long as the request was out. The fade is on the
// report's marks now (contrast-floors.test.ts measures that), so the words have
// to say it instead, at the contrast they already have — beside the figures
// that are about to change, and on an empty window, which has no marks to fade.
//
// Rendered the way projects-day-chart-group-1774 renders the modal: server-side
// over a seeded report, the portal flattened in place. The reducer's initial
// state is the seam: a load generation ahead of the report's is a new window
// still loading over the last one.
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

/** The modal over a 7-day report, either settled or with the next window's
 *  load still out, and with or without any work in it. */
function render({ reloading, empty = false }: { reloading: boolean; empty?: boolean }): string {
  const daily = empty ? [] : [{
    day: "2026-09-22",
    projects: [{ path: "/u/alpha", models: { [MODEL]: c(1_000, 20_000) } }],
    unattributed: null,
  }];
  const data = { trackedSince: null, days: 7, projects: [], unattributed: null, daily };
  seed.load.gen = reloading ? 1 : 0;
  seed.load.report = { gen: 0, days: 7, data, cost: { phase: "failed" } };
  return renderToStaticMarkup(createElement(AccountProjectsModal, { num: 1, name: "a@x.io", onClose: () => {} }));
}

describe("a Projects report reloading over the last one says so in words (#1787)", () => {
  it("keeps the last report up, marked as reloading, while the next window loads", () => {
    expect(render({ reloading: true })).toContain('<div class="ap-proj-body refreshing" aria-busy="true">');
    expect(render({ reloading: false })).toContain('<div class="ap-proj-body" aria-busy="false">');
  });

  it("says the figures are updating beside them, in place of the window they were for", () => {
    expect(render({ reloading: true })).toContain('<span class="ap-proj-total-win">· updating…</span>');
    expect(render({ reloading: false })).toContain('<span class="ap-proj-total-win">· the last 7 days</span>');
  });

  it("says it on an empty window too, where there is no mark left to fade", () => {
    expect(render({ reloading: true, empty: true })).toMatch(/<div class="ap-proj-state">Updating…</);
    expect(render({ reloading: false, empty: true }))
      .toMatch(/<div class="ap-proj-state">No work attributed to this account in the last 7 days\.</);
  });
});
