// #1627: a seven-day window nobody measured was drawn as "< 1%".
//
// Anthropic's usage endpoint can answer with `seven_day: null`, and claude-swap
// then stores a row with no `seven_day` at all. Both mappings in
// quota-shape.mjs filled that gap with a zero, and QuotaBar prints a zero as
// "< 1%" over a sliver of fill — a week that reads as barely touched, on a
// reading that said nothing about the week. The same kind of zero #765 took
// out of the no-subscription branch.
//
// The third source already told the truth by leaving the field out: when
// `claude /usage` prints no week line, the reading has no `week7dPct`. The
// panel then hid the row, so one missing window looked like two different
// things depending on where the numbers came from.
//
// Now every source publishes the gap as unknown, and the bar says "no reading".
// A week that really is at 0% still says "< 1%": the fix is for the absence
// of a number, never for a small one.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error — plain JS module, no types
import { mapOAuthUsage, parseUsageText, quotaFromStore } from "../../server/quota-shape.mjs";
import QuotaBar from "../components/QuotaBar";
import { ClaudeQuotaSection } from "../components/QuotaSections";
import type { QuotaData } from "../use-quota";

/** A claude-swap row as activeAccountUsage() returns it. */
const entry = (lastGood: unknown) => ({ num: 2, email: "a@b.c", lastGood, fetchedAt: 1_000_000 });

/** What the route sends, which is JSON: undefined would not survive it. */
const wire = (q: unknown) => JSON.parse(JSON.stringify(q));

describe("a seven-day window the source did not send", () => {
  it("is unknown on the OAuth path, however it is missing", () => {
    for (const body of [
      { five_hour: { utilization: 10 } },
      { five_hour: { utilization: 10 }, seven_day: null },
      { five_hour: { utilization: 10 }, seven_day: { utilization: null, resets_at: null } },
    ]) {
      const q = wire(mapOAuthUsage(body));
      expect(q.session5hPct, JSON.stringify(body)).toBe(10);
      expect(q.week7dPct, JSON.stringify(body)).toBeNull();
    }
  });

  it("is unknown on the store path", () => {
    const q = wire(quotaFromStore(entry({ five_hour: { pct: 10, resets_at: "2026-09-28T14:40:00Z" } })));
    expect(q.session5hPct).toBe(10);
    expect(q.week7dPct).toBeNull();
  });

  it("is left out on the CLI path, which the panel reads the same way", () => {
    const q = parseUsageText("Current session: 10% used · resets 4:09pm (Europe/Chisinau)");
    expect(q.session5hPct).toBe(10);
    expect(q.week7dPct).toBeUndefined();
  });

  it("is not confused with a week that really is at zero", () => {
    expect(mapOAuthUsage({ five_hour: { utilization: 10 }, seven_day: { utilization: 0 } }).week7dPct).toBe(0);
    expect(quotaFromStore(entry({ five_hour: { pct: 10 }, seven_day: { pct: 0 } })).week7dPct).toBe(0);
  });
});

describe("the bar for a window with no reading", () => {
  const NOW = 1_790_550_000;

  it("says so, and draws no fill and no pace", () => {
    const html = renderToStaticMarkup(createElement(QuotaBar, {
      label: "7-day window", pct: null, resetAt: NOW + 3 * 86400, windowSec: 604800, nowSec: NOW,
    }));
    expect(html).toContain(">no reading<");
    expect(html).not.toContain("&lt; 1%");
    expect(html).not.toContain("qb-fill");
    expect(html).not.toContain("qb-pace");
  });

  it("still prints a real zero as under one per cent", () => {
    const html = renderToStaticMarkup(createElement(QuotaBar, { label: "7-day window", pct: 0, nowSec: NOW }));
    expect(html).toContain("&lt; 1%");
    expect(html).toContain("qb-fill");
    expect(html).not.toContain("no reading");
  });

  it("is drawn in the Claude section for every source's gap", () => {
    const api = wire(mapOAuthUsage({ five_hour: { utilization: 10 } }));
    const cli = parseUsageText("Current session: 10% used");
    for (const reading of [api, cli]) {
      const quota: QuotaData = { ok: true, ...reading, fetchedAt: NOW * 1000 };
      const html = renderToStaticMarkup(createElement(ClaudeQuotaSection, { quota, quotaLoading: false, nowSec: NOW }));
      const week = html.slice(html.indexOf("7-day window"));
      expect(html).toContain("7-day window");
      expect(week).toContain(">no reading<");
      expect(html).toContain(">10%<");
    }
  });
});
