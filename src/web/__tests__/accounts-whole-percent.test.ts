// Every percentage in the accounts panel is a whole one.
//
// claude-swap stores Anthropic's utilisation as it came, and the server passes
// any finite number through: nothing between the store and the panel rounds a
// lane, and the headroom beside it is `100 - max(pct)` computed in floating
// point. The shut row and the Usage panel round (#1804); the open row's bars
// printed the number raw — "85.555555%" over a shut-row "86%" for the same
// window — and the strained rest line and the fold's peek printed float noise
// like "14.444445000000002% free".
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import type { Account } from "../claude-accounts";
import { restLine, type Peer } from "../other-accounts";
import { sourceOf } from "./client-source";

const NOW = 1_790_000_000;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the open row's bars", () => {
  const account: Account = {
    num: 1, email: "a@x.io", alias: null, org: null, active: true, disabled: false,
    lanes: [
      { id: "five_hour", label: "5h", pct: 85.555555, resetAt: NOW + 3600 },
      { id: "seven_day", label: "7d", pct: 12.5, resetAt: NOW + 3 * 86_400 },
    ],
    headroom: 14.444445000000002, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null,
  };
  const html = renderToStaticMarkup(createElement(AccountRow, {
    a: account, nowSec: NOW, opened: true, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));
  const printed = [...html.matchAll(/class="ap-lane-pct"[^>]*>([^<]+)</g)].map(m => m[1]);

  it("print the whole percentage the shut row prints", () => {
    expect(printed).toEqual(["86%", "13%"]);
    expect(text(html)).not.toContain("85.5");
  });
});

describe("the room the other accounts have", () => {
  const peer = (name: string, headroom: number): Peer => ({ key: name, name, ready: true, why: null, warn: false, headroom });

  it("is a whole percentage on the rest line", () => {
    const line = restLine([peer("a", 14.444445000000002), peer("b", 3.2)], { strained: true, armed: false });
    expect(line.text).toContain("14% free");
    expect(line.text).not.toContain("14.4");
  });

  it("is a whole percentage on the fold's peek", () => {
    // The peek is portalled and opens on a pointer, which a static render
    // cannot reach; what it prints for a ready account is read from its source.
    const fold = sourceOf("components/OtherAccounts.tsx");
    expect(fold).toContain("`${Math.round(p.headroom)}% free`");
    expect(fold).not.toContain("`${p.headroom}% free`");
  });
});
