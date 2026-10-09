// A quota bar whose window has reset since its reading was taken.
//
// The Usage panel holds the last reading it was given until the next one
// lands — a poll a minute apart, a laptop lid closed over a reset, a server
// waiting out a 429 or its own five-minute floor — and the bar went on
// presenting that reading as the current window. Past the reset there was no
// countdown left to print, so the row fell back to the absolute label and read
// "resets Oct 5, 3:00pm" at a time already gone; and the pace, measured against
// a window that had fully elapsed, called a full bar "used up" and a 60% one
// "40% under pace". The window those numbers describe is over.
//
// So a bar whose reset has passed says that and nothing else: no fill, no
// level colour, no pace, no past time after "resets" — until a reading of the
// new window arrives.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar from "../components/QuotaBar";
import AccountRow from "../components/AccountRow";
import type { Account } from "../claude-accounts";

const RESET = 18_000;
const bar = (props: { pct: number | null; nowSec: number; limitReached?: boolean }) =>
  renderToStaticMarkup(createElement(QuotaBar, {
    label: "5-hour window", reset: "Oct 5, 3:00pm", resetAt: RESET, windowSec: 18_000, ...props,
  }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("a quota bar after its window has reset", () => {
  it("does not print the time the window already reset at", () => {
    const html = bar({ pct: 100, nowSec: RESET + 120 });
    expect(text(html)).not.toContain("resets Oct 5, 3:00pm");
    expect(text(html)).not.toContain("resets in");
  });

  it("does not present the old reading as the current window", () => {
    const html = bar({ pct: 100, nowSec: RESET + 1800, limitReached: true });
    expect(text(html)).not.toContain("100%");
    expect(text(html)).not.toContain("used up");
    expect(html).not.toContain("qb-fill");
    expect(html).not.toContain("qb-pace");
    expect(html).not.toContain("qb-limit-badge");
  });

  it("gives a part-used reading no pace against a window that is over", () => {
    const html = bar({ pct: 60, nowSec: RESET + 600 });
    expect(text(html)).not.toContain("under pace");
    expect(text(html)).not.toContain("60%");
  });

  it("says the window has reset and a new reading is awaited", () => {
    const t = text(bar({ pct: 97, nowSec: RESET + 1 }));
    expect(t).toContain("reset");
    expect(t).toContain("waiting for a new reading");
  });

  it("counts the reset instant itself as reset", () => {
    expect(text(bar({ pct: 97, nowSec: RESET }))).toContain("waiting for a new reading");
  });

  it("draws a window still running as it always has", () => {
    const t = text(bar({ pct: 60, nowSec: RESET - 3600 }));
    expect(t).toContain("60%");
    expect(t).toContain("resets in 1h");
    expect(t).not.toContain("waiting for a new reading");
  });
});

// The accounts panel draws the same windows from claude-swap's rows, and the
// live account's row is always open on its bars. A row collected ten minutes
// ago is not stale, and its 5-hour window can still have reset since.
describe("an open account row whose window has reset since its collection", () => {
  const NOW = 1_790_000_000;
  const account = (resetAt: number): Account => ({
    num: 1, email: "a@x.io", alias: null, org: null, active: true, disabled: false,
    lanes: [
      { id: "five_hour", label: "5h", pct: 92, resetAt },
      { id: "seven_day", label: "7d", pct: 30, resetAt: NOW + 3 * 86_400 },
    ],
    headroom: 8, fetchedAt: (NOW - 600) * 1000, nextAt: null, stale: false, error: null,
  });
  const row = (a: Account) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: NOW, opened: true, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));
  /** The 5h lane's markup, from its label to the end of its reset slot. */
  const fiveHour = (html: string) => /title="5h"[^]*?class="ap-lane-reset"[^]*?<\/span><\/div>/.exec(html)?.[0] ?? "";

  // Until accounts-open-row-reset the old number stayed on the face, muted,
  // with "reset" in the countdown's slot — and a frozen row printed only the
  // number. Now "reset" takes the number's place on every row, as the shut row
  // and the capacity report put it, and the number moves to the title.
  it("says reset where the old number was, in the record's ink, not the warning's", () => {
    const lane = fiveHour(row(account(NOW - 600)));
    expect(lane).toMatch(/<span class="ap-lane-pct" style="color:var\(--muted\)"[^>]*><span aria-hidden="true">reset<\/span>/);
    expect(lane).not.toContain("var(--err)");
    expect(lane).not.toContain(">92%<");
    expect(lane).not.toContain("ap-lane-fill");
  });

  it("keeps when it reset and what it read on hover and for a screen reader", () => {
    const lane = fiveHour(row(account(NOW - 600)));
    expect(lane).toContain('title="Reset 10m ago, 92% when read 10m ago"');
    expect(lane).toContain('<span class="vis-hidden">Reset 10m ago, 92% when read 10m ago</span>');
    expect(lane).toContain('<span class="ap-lane-reset"></span>');
  });

  it("keeps a window still running in its level's ink, with its countdown", () => {
    const lane = fiveHour(row(account(NOW + 3600)));
    expect(lane).toContain("var(--err)");
    expect(text(lane)).toContain("resets in 1h");
    expect(text(lane)).not.toMatch(/\breset$/);
  });
});
