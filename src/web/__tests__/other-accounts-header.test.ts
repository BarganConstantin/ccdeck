// The head of the Other accounts group (V4's Figma).
//
// One toggle — a chevron and "Other accounts" — 28 high, with "Expand every
// account" at its right end while the list is open.
//
// CHANGED ON PURPOSE (internal #94): the list's order menu is gone. The list
// stands usable first (other-accounts-order-1579.test.ts), so the head has no
// order to show and nothing to choose.
//
// What these pin: the toggle; expand-all as a pressed-or-not toggle beside it;
// the auto-switch alarm; and that no order control is drawn.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OtherAccounts from "../components/OtherAccounts";
import type { Peer } from "../other-accounts";
import { sheetText } from "./sheet-source";

const peer = (key: string, ready: boolean, headroom: number | null = 50): Peer => ({
  key, name: `${key}@northwind.example`, ready, why: ready ? null : "held out", warn: false, headroom,
});

const props = (over: Record<string, unknown> = {}) => ({
  peers: [peer("a", true), peer("b", true), peer("c", false)], strained: false, armed: false, threshold: null,
  open: false, onToggle: () => {},
  allOpen: false, onToggleAll: () => {}, ...over,
});
const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OtherAccounts, props(over)));
const toggle = (out: string) => /<button type="button" id="ap-rest-entry"[^]*?<\/button>/.exec(out)?.[0] ?? "";
const text = (s: string) => s.replace(/<span class="vis-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("line 1, the one toggle", () => {
  it("is a chevron and title without account counts", () => {
    const shut = html();
    expect(toggle(shut)).toMatch(/^<button type="button" id="ap-rest-entry" class="ap-nav ap-sum" aria-expanded="false">/);
    expect(toggle(shut)).toContain('class="ap-nav-chev"');
    expect(toggle(shut)).toContain('<span class="ap-nav-name">Other accounts</span>');
    expect(shut).not.toContain('class="ap-sum-count"');
    expect(shut).not.toContain('class="ap-rest-ready"');
    // The heading remains the same when none can be switched to.
    expect(text(toggle(html({ peers: [peer("a", false), peer("b", false)] })))).toBe("Other accounts");
  });

  it("says it is open, and names the box it opens only while that box is there", () => {
    expect(toggle(html({ open: true }))).toContain('aria-expanded="true" aria-controls="ap-rest-panel"');
    expect(toggle(html())).not.toContain("aria-controls");
  });

  it("is 28 high and keeps its title on one line", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-rest \.ap-nav\.ap-sum \{[^}]*min-height: 28px;/);
    expect(css).toMatch(/\.ap-sum \.ap-nav-name \{[^}]*font-size: calc\(13px[^}]*font-weight: 500;[^}]*color: var\(--text\);[^}]*white-space: nowrap;/);
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a pill is the pill token.
    // CHANGED ON PURPOSE (V4 top-10 #8): mono → sans + tabular-nums, because the count is a figure, not code.
    expect(css).toMatch(/\.ap-sum-count \{[^}]*height: 18px;[^}]*border-radius: var\(--r-pill\);[^}]*font-family: var\(--font-sans\);[^}]*font-variant-numeric: tabular-nums;/);
  });
});

describe("expand every account", () => {
  const all = (out: string) => /<button type="button" class="ap-rest-all"[^]*?<\/button>/.exec(out)?.[0] ?? "";

  it("stands at the right end of line 1 while the list is open, beside the toggle and not in it", () => {
    expect(all(html())).toBe("");
    const open = html({ open: true });
    expect(all(open)).not.toBe("");
    expect(open.indexOf('class="ap-rest-all"')).toBeGreaterThan(open.indexOf(toggle(open)) + toggle(open).length - 1);
    expect(open).not.toContain('class="ap-rest-line"');
  });

  it("is a toggle with one name, pressed while every row is open, its tooltip the next press", () => {
    expect(all(html({ open: true }))).toMatch(/aria-label="Expand every account" aria-pressed="false" aria-controls="ap-rest-list" title="Expand every account"/);
    expect(all(html({ open: true, allOpen: true }))).toMatch(/aria-label="Expand every account" aria-pressed="true" aria-controls="ap-rest-list" title="Collapse every account"/);
    // Its own glyph, turned to say which press is next.
    const glyph = (out: string) => /<path d="([^"]+)"/.exec(all(out))?.[1];
    expect(glyph(html({ open: true }))).not.toBe(glyph(html({ open: true, allOpen: true })));
    expect(sheetText()).toMatch(/\.ap-rest-all \{[^}]*width: 24px;[^}]*height: 24px;/);
  });
});

describe("auto-switch warning", () => {
  it("carries the alarm in the error ink when auto-switch has nowhere to go", () => {
    const out = html({ armed: true, peers: [peer("a", false), peer("b", false), peer("c", false)] });
    expect(out).toMatch(/<p class="ap-rest-alarm"><svg class="ap-rest-alarm-glyph"[^]*Auto-switch has nowhere to go/);
    expect(sheetText()).toMatch(/\.ap-rest-alarm \{[^}]*font-weight: 500;[^}]*color: var\(--err\);/);
  });
});

describe("no order control (internal #94)", () => {
  it("is drawn, open or shut, and the sheet keeps no rule for one", () => {
    for (const out of [html(), html({ open: true })]) {
      expect(out).not.toContain("ap-rest-sort");
      expect(out).not.toContain('aria-haspopup="menu"');
    }
    const css = sheetText();
    expect(css).not.toContain("ap-rest-sort");
    expect(css).not.toContain("ap-sort-pop");
    expect(css).not.toContain("container: ap-rest");
  });
});
