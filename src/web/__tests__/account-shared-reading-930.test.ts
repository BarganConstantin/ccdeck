// #930: an account whose numbers a paired deck read looks as it always has —
// the age, nothing added to the row — and names that deck on hover, open or
// shut.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import type { Account } from "../claude-accounts";

const NOW = 1_790_000_000;
const account = (over: Partial<Account> = {}): Account => ({
  num: 1, email: "a@x.io", alias: null, org: null, active: true, disabled: false,
  lanes: [
    { id: "five_hour", label: "5h", pct: 42, resetAt: NOW + 7200 },
    { id: "seven_day", label: "7d", pct: 11, resetAt: NOW + 3 * 86_400 },
  ],
  headroom: 58, fetchedAt: (NOW - 180) * 1000, nextAt: null, stale: false, error: null,
  ...over,
});
const row = (a: Account, opened: boolean) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {},
} as never));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("an account read on a paired deck", () => {
  it("adds nothing to the row, and says which deck and why on hover", () => {
    const html = row(account({ sharedFrom: "iMac" }), true);
    expect(text(html)).toContain("collected 3m ago");
    expect(text(html)).not.toContain("iMac");
    expect(html).toContain('title="Read on iMac, a paired deck. One deck reads each account you share');
  });

  it("is told apart on hover from one this deck reads", () => {
    const own = row(account({ nextAt: (NOW + 120) * 1000 }), true);
    expect(own).not.toContain("iMac");
    expect(own).toContain("When claude-swap last read this account&#x27;s usage");
  });

  it("keeps a shut row's age alone, naming the deck only on hover", () => {
    const html = row(account({ active: false, stale: true, sharedFrom: "iMac" }), false);
    expect(html).toMatch(/<span class="ap-q-age" title="Read on iMac, a paired deck">3m ago<\/span>/);
    expect(text(html)).not.toContain("iMac");
  });
});
