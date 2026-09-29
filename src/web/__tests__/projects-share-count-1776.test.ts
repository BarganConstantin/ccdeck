// #1776. Two counts that read wrong aloud.
//
// The Projects report's share bar is named "Share of $X across N projects",
// and N was the number of ROWS it drew: the first six projects plus one folded
// Other row, so ten projects said "across 7 projects" beside a row reading
// "Other · 4 projects". One project said "across 1 projects". And a session
// card whose agent had spawned one subagent carried "1 subagents spawned" on
// its → 1 badge. Both files already pluralise their other counts ("Other · N
// project(s)", "day(s)"); these two had a fixed plural.
//
// The bar is rendered, the way projects-day-chart-group-1774 renders the
// modal: server-side over a seeded report whose first load has landed, the
// portal flattened in place. The badge's words are a pure function; the card
// is a React Flow node this suite cannot mount, so its use of them is read.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Counters } from "../account-projects-reconcile";
import { spawnBadgeTitle } from "../agent-copy";
import { sourceOf } from "./client-source";

const seed = vi.hoisted(() => ({ load: { gen: 0, report: null as unknown, error: null, early: null } }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../account-projects-load", async (orig) => ({ ...(await orig<typeof import("../account-projects-load")>()), INITIAL_LOAD: seed.load }));

const { default: AccountProjectsModal } = await import("../components/AccountProjectsModal");

const PRICED = "claude-opus-4-5-20251101";
const UNPRICED = "claude-opus-5-6";   // no row in this build's rate table
const c = (i: number, o: number): Counters => ({ i, o, cr: 0, cc: 0, c1h: 0, c5m: 0 });

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

/** The share bar's accessible name, for a 7-day report over `count` projects. */
function barLabel(count: number, model = PRICED): string {
  const projects = Array.from({ length: count }, (_, k) => ({
    path: `/u/p${k}`, models: { [model]: c(1_000 * (count - k), 10_000 * (count - k)) },
  }));
  const data = { trackedSince: null, days: 7, projects: [], unattributed: null, daily: [{ day: "2026-09-22", projects, unattributed: null }] };
  seed.load.report = { gen: 0, days: 7, data, cost: { phase: "failed" } };
  const html = renderToStaticMarkup(createElement(AccountProjectsModal, { num: 1, name: "a@x.io", onClose: () => {} }));
  const m = /<div class="ap-proj-bar" role="img" aria-label="([^"]*)">/.exec(html);
  if (!m) throw new Error("no share bar in the render");
  return m[1];
}

describe("the share bar counts projects, not the rows it drew (#1776)", () => {
  it("says ten for ten, beside the Other row that folds four of them", () => {
    expect(barLabel(10)).toMatch(/ across 10 projects$/);
  });

  it("says one project for one", () => {
    expect(barLabel(1)).toMatch(/ across 1 project$/);
  });

  it("counts the same way when the share is of tokens", () => {
    // An unpriced model makes the bar a share of tokens (#1330): same count.
    expect(barLabel(10, UNPRICED)).toMatch(/^Share of .* tokens across 10 projects$/);
    expect(barLabel(1, UNPRICED)).toMatch(/^Share of .* tokens across 1 project$/);
  });
});

describe("the spawn badge says subagent for one (#1776)", () => {
  it("pluralises on the count", () => {
    expect(spawnBadgeTitle(1)).toBe("1 subagent spawned");
    expect(spawnBadgeTitle(2)).toBe("2 subagents spawned");
    expect(spawnBadgeTitle(12)).toBe("12 subagents spawned");
  });

  it("is the title the card puts on its badge", () => {
    expect(sourceOf("components/AgentNode.tsx")).toMatch(/<span className="spawn-badge" title=\{spawnBadgeTitle\(data\.childCount\)\}>/);
  });
});
