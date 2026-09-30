// #1806: the usage panel said "No usage all time. Try a longer period."
//
// When ccusage answered with no usage at all, the empty state printed "No
// usage {noun}." and, whenever the reading came from a range, "Try a longer
// period." after it. On `all` the noun is "all time", so the panel offered a
// longer period than every transcript on disk, in a sentence that does not
// read. The hint is kept for the periods that have a longer one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeriodKey } from "../usage-from-ccusage";

const range = vi.hoisted(() => ({ shown: "all" as string }));

vi.mock("../use-usage-range", () => ({
  useUsageRange: () => ({
    data: {
      days: [],
      sessions: [],
      totals: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 },
    },
    shown: range.shown,
    stale: false,
    loading: false,
    baseline: null,
  }),
}));

const { default: UsagePanel } = await import("../components/UsagePanel");
const { initialState } = await import("../reducer");
const { ASSUMED } = await import("../providers");

function emptyText(shown: PeriodKey): string {
  range.shown = shown;
  const html = renderToStaticMarkup(createElement(UsagePanel, {
    state: initialState(),
    now: 0,
    providers: { ...ASSUMED, claude: false, codex: false },
    onClose: () => {},
  }));
  const m = /<div class="up-empty">(.*?)<\/div>/s.exec(html);
  expect(m, "the panel drew no empty state").not.toBeNull();
  return m![1].replace(/<!--.*?-->/gs, "");
}

describe("the usage panel's empty state (#1806)", () => {
  beforeEach(() => { range.shown = "all"; });

  it("offers no longer period on the longest there is", () => {
    const text = emptyText("all");
    expect(text).not.toContain("Try a longer period");
    expect(text).not.toContain("No usage all time");
    expect(text).toContain("No usage in any transcript on this machine.");
  });

  it.each([
    ["today", "No usage today."],
    ["month", "No usage this month."],
  ] as const)("still points %s at a longer period", (shown, first) => {
    const text = emptyText(shown);
    expect(text).toContain(first);
    expect(text).toContain("Try a longer period.");
  });
});
