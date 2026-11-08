// The head of the Other accounts group (V4's Figma): two lines.
//
// Line 1 is one toggle — a chevron, "Other accounts" and a count of every other
// account — 28 high, with "Expand every account" at its right end while the
// list is open. Line 2 is a green dot and how many a switch would reach, with
// the list's order at its right end: one menu of the orders, the direction
// inside each choice, which reorders the rows and leaves the group open.
//
// What these pin: the toggle and its count; expand-all as a pressed-or-not
// toggle beside it; the count line, which counts reach, not room; the order's
// button, its menu and how the menu answers; and the sheet that keeps the
// title on one line and the order down to its glyphs under 240 wide.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OtherAccounts from "../components/OtherAccounts";
import { orderChoices, SLOT_ORDER } from "../other-accounts-order";
import type { Account } from "../claude-accounts";
import type { Peer } from "../other-accounts";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";
import { withoutComments } from "./tsx-scan";

const peer = (key: string, ready: boolean, headroom: number | null = 50): Peer => ({
  key, name: `${key}@northwind.example`, ready, why: ready ? null : "held out", warn: false, headroom,
});
const lane = (id: string, label: string, pct: number) => ({ id, label, pct, resetAt: null });
const acct = (num: number): Account => ({
  num, email: `a${num}@x.io`, alias: null, org: null, active: false, disabled: false,
  lanes: [lane("five_hour", "5h", 10 * num), lane("seven_day", "7d", 5 * num)],
  headroom: 100 - 10 * num, fetchedAt: null, nextAt: null, stale: false, error: null,
});
const CHOICES = orderChoices([acct(2), acct(3)]);

const props = (over: Record<string, unknown> = {}) => ({
  peers: [peer("a", true), peer("b", true), peer("c", false)], strained: false, armed: false, threshold: null,
  open: false, onToggle: () => {}, order: SLOT_ORDER, choices: CHOICES, onOrder: () => {},
  allOpen: false, onToggleAll: () => {}, ...over,
});
const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(OtherAccounts, props(over)));
const toggle = (out: string) => /<button type="button" id="ap-rest-entry"[^]*?<\/button>/.exec(out)?.[0] ?? "";
const text = (s: string) => s.replace(/<span class="vis-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("line 1, the one toggle", () => {
  it("is a chevron, the title and a count of every other account, in one button", () => {
    const shut = html();
    expect(toggle(shut)).toMatch(/^<button type="button" id="ap-rest-entry" class="ap-nav ap-sum" aria-expanded="false">/);
    expect(toggle(shut)).toContain('class="ap-nav-chev"');
    expect(toggle(shut)).toContain('<span class="ap-nav-name">Other accounts</span><span class="ap-sum-count">3</span>');
    // Every other account, not only the ones a switch reaches.
    expect(text(toggle(html({ peers: [peer("a", false), peer("b", false)] })))).toBe("Other accounts 2");
  });

  it("says it is open, and names the box it opens only while that box is there", () => {
    expect(toggle(html({ open: true }))).toContain('aria-expanded="true" aria-controls="ap-rest-panel"');
    expect(toggle(html())).not.toContain("aria-controls");
  });

  it("is 28 high and keeps its title on one line", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-rest \.ap-nav\.ap-sum \{[^}]*min-height: 28px;/);
    expect(css).toMatch(/\.ap-sum \.ap-nav-name \{[^}]*font-size: calc\(13px[^}]*font-weight: 500;[^}]*color: var\(--text\);[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.ap-sum-count \{[^}]*height: 18px;[^}]*border-radius: 999px;[^}]*font-family: var\(--font-mono\);/);
  });
});

describe("expand every account", () => {
  const all = (out: string) => /<button type="button" class="ap-rest-all"[^]*?<\/button>/.exec(out)?.[0] ?? "";

  it("stands at the right end of line 1 while the list is open, beside the toggle and not in it", () => {
    expect(all(html())).toBe("");
    const open = html({ open: true });
    expect(all(open)).not.toBe("");
    expect(open.indexOf('class="ap-rest-all"')).toBeGreaterThan(open.indexOf(toggle(open)) + toggle(open).length - 1);
    expect(open).toMatch(/<div class="ap-rest-head"><button type="button" id="ap-rest-entry"[^]*?<\/button><button type="button" class="ap-rest-all"/);
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

describe("line 2, how many a switch would reach", () => {
  it("counts the accounts that are signed in and not held out, with a green dot and a tooltip", () => {
    const out = html();
    expect(out).toContain('<span class="ap-rest-ready" data-tone="ok" title="Signed in and not held out. Each row says its limits."><i class="ap-rest-dot" aria-hidden="true"></i><span class="ap-rest-ready-text">2 can be switched to</span></span>');
  });

  it("says none of them can, with a dim dot, when none can", () => {
    const out = html({ peers: [peer("a", false), peer("b", false), peer("c", false)] });
    expect(out).toMatch(/<span class="ap-rest-ready" data-tone="idle"[^>]*>[^]*None of 3 can be switched to/);
    const css = sheetText();
    expect(css).toMatch(/\.ap-rest-dot \{[^}]*width: 6px;[^}]*background: var\(--ok\);/);
    expect(css).toContain('.ap-rest-ready[data-tone="idle"] .ap-rest-dot { background: var(--muted-dim); }');
  });

  it("counts reach, not room: a full account still counts, and no line says how many have room", () => {
    const full = html({ peers: [peer("a", true, 0), peer("b", true, 0)] });
    expect(text(full)).toContain("2 can be switched to");
    expect(text(full)).not.toMatch(/with room|ready/);
    // What room each has is the previews' to say, one per name, while shut.
    expect(full).toMatch(/<p class="ap-preview"><span class="ap-preview-name"[^>]*>a@northwind\.example<\/span><span class="ap-preview-state">/);
  });

  it("carries the alarm in the error ink when auto-switch has nowhere to go", () => {
    const out = html({ armed: true, peers: [peer("a", false), peer("b", false), peer("c", false)] });
    expect(out).toMatch(/<p class="ap-rest-alarm"><svg class="ap-rest-alarm-glyph"[^]*Auto-switch has nowhere to go/);
    expect(sheetText()).toMatch(/\.ap-rest-alarm \{[^}]*font-weight: 500;[^}]*color: var\(--err\);/);
  });
});

describe("the order", () => {
  const sort = (out: string) => /<button type="button" id="ap-rest-sort"[^]*?<\/button>/.exec(out)?.[0] ?? "";
  const code = withoutComments(sourceOf("components/OtherAccounts.tsx"));

  it("stands at the right end of line 2 while the list is open, showing the order the list is in", () => {
    expect(sort(html())).toBe("");
    const out = html({ open: true, order: "7d:empty" });
    expect(out).toMatch(/<div class="ap-rest-line"><span class="ap-rest-ready"[^]*?<\/span><\/span><button type="button" id="ap-rest-sort"/);
    expect(sort(out)).toMatch(/aria-haspopup="menu" aria-expanded="false" title="7-day · emptiest first" data-sorted=""/);
    expect(text(sort(out))).toBe("7-day · emptiest first");
    // Its name to a screen reader says what it orders.
    expect(sort(out)).toContain('<span class="vis-hidden">Order of the other accounts: </span>');
    expect(text(sort(html({ open: true })))).toBe("Slot");
  });

  it("offers six orders for the two windows, the direction inside each choice", () => {
    expect(CHOICES.map(c => c.label)).toEqual([
      "Slot", "Most room", "5-hour · fullest first", "5-hour · emptiest first", "7-day · fullest first", "7-day · emptiest first",
    ]);
  });

  it("opens a menu of radio items, the chosen one ticked, that reorders and keeps the group open", () => {
    expect(code).toMatch(/<AnchoredPopover anchorId=\{id\}[^>]*className="ap-pop ap-sort-pop" role="menu" labelledBy=\{id\}/);
    expect(code).toMatch(/role="menuitemradio" aria-checked=\{c\.id === order\}/);
    expect(code).toMatch(/\{c\.id === order && <span className="ap-menu-check" aria-hidden>✓<\/span>\}/);
    // A choice orders the list, hands focus back to the button and shuts the
    // menu — and nothing else: the group's toggle is not touched.
    expect(code).toMatch(/const choose = \(next: string\) => \{\s*onOrder\(next\);\s*document\.getElementById\(id\)\?\.focus\(\);\s*setMenu\(null\);\s*\};/);
    expect(code).not.toMatch(/choose[^}]*onToggle/);
    // The arrow keys open it at the first or the last order, as a native menu button does.
    expect(code).toMatch(/setMenu\(e\.key === "ArrowUp" \? "last" : "first"\)/);
    // And the popover walks radio items with the arrows, as it walks menu items.
    expect(sourceOf("components/AnchoredPopover.tsx")).toContain('const ITEM = \'[role="menuitem"], [role="menuitemradio"]\';');
  });

  it("is quiet at rest, filled under the pointer and while its menu is open, and dashed while held", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-rest-sort \{[^}]*height: 22px;[^}]*border: 1px solid transparent;[^}]*background: none;/);
    expect(css).toContain('.ap-rest-sort[aria-expanded="true"] { background: var(--ctl-fill); }');
    expect(css).toContain(".ap-rest-sort[data-held] { border-style: dashed; border-color: var(--ctl-edge); }");
    expect(css).toMatch(/\.ap-pop\.ap-sort-pop \{ width: 200px; \}/);
  });

  it("gives way before the count on a short line, never below its glyph and chevron", () => {
    const css = sheetText();
    // Beside the order the count does not shrink at all (a shared shrink takes
    // a sliver from it, enough for an ellipsis), up to the line less the
    // order's glyphs; the order shrinks to those glyphs and no further.
    expect(css).toContain(".ap-rest-line:has(.ap-rest-sort) > .ap-rest-ready { flex: none; max-width: calc(100% - 50px); }");
    expect(css).toMatch(/\.ap-rest-sort \{\s*flex: 0 1 auto;[^}]*min-width: 44px;/);
    // Alone on the line (the group shut), the count has the whole line.
    expect(css).toMatch(/\.ap-rest-ready \{[^}]*min-width: 0;/);
  });

  it("keeps only its glyph and chevron under 240 wide, its name in the tooltip and to a screen reader", () => {
    const css = sheetText();
    // The group is the container; its 4px inset each side makes 232 inside a 240 column.
    expect(css).toContain(".ap-rest { container: ap-rest / inline-size; }");
    // Its own width then follows the two glyphs, with no room kept for the name.
    expect(css).toMatch(/@container ap-rest \(width < 232px\) \{\s*\.ap-rest-sort \{ min-width: auto; \}\s*\.ap-rest-sort-name \{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip-path: inset\(50%\);/);
    expect(sort(html({ open: true, order: "5h:full" }))).toContain('title="5-hour · fullest first"');
  });
});
