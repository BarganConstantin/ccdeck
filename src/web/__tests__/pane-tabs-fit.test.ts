// A pane's tab strip in a narrow header (PaneTabs.tsx, workspace-split.css):
// no word paints over the next tab, the state word gives way before the name,
// the tab on show is never wider than the strip, a narrow tabbed header gives
// the strip the context chip's room, and the strip keeps the right tab in view.
//
// Before: a tab squeezed to its 64px floor kept its state word whole
// (`flex: none`), so "ended 2m ago" painted over the next tab's word, and the
// tab on show (`min-width: max-content`) was wider than the strip, whose edge
// cut its name to a letter or two.
//
// CHANGED ON PURPOSE: a tab and the × it draws under the pointer share a slot
// (PaneTabs.tsx StripTab), and the slot is what the strip sizes now, with the
// floor, the cap and the clip the tab had; the tab fills its slot and gives
// way with it, so every sum below is the same.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import { revealBy, tabInView, type PaneTabsView } from "../components/terminal/PaneTabs";

const css = readFileSync(fileURLToPath(new URL("../styles/workspace-split.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the rule whose selector is exactly `sel` (at a line's start). */
function rule(sel: string): string {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
/** A declaration's value in a rule body, whitespace collapsed. */
const decl = (body: string, prop: string) =>
  new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(body)?.[1].replace(/\s+/g, " ").trim();
/** The flex-shrink a rule gives: `flex: <grow> <shrink> <basis>`, else 1. */
const shrinkOf = (body: string) => Number(decl(body, "flex")?.split(" ")[1] ?? 1);

/** One flex line shrunk into `room` as CSS does it: each item gives way in
 *  proportion to its flex-shrink times its base size, and stops at its min. */
function shrinkLine(room: number, items: { basis: number; shrink: number; min: number }[]): number[] {
  const size = items.map(x => x.basis);
  const frozen = items.map(() => false);
  for (let pass = 0; pass < items.length + 1; pass++) {
    const free = room - size.reduce((a, b, k) => a + (frozen[k] ? b : items[k]!.basis), 0);
    if (free >= 0) return items.map((x, k) => (frozen[k] ? size[k]! : x.basis));
    const scaled = items.map((x, k) => (frozen[k] ? 0 : x.shrink * x.basis));
    const total = scaled.reduce((a, b) => a + b, 0);
    if (!total) return size;
    let clamped = false;
    items.forEach((x, k) => {
      if (frozen[k]) return;
      const want = x.basis + free * (scaled[k]! / total);
      if (want < x.min) { size[k] = x.min; frozen[k] = true; clamped = true; } else size[k] = want;
    });
    if (!clamped) return size;
  }
  return size;
}

const tab = rule(".ts-tabs .ts-tab-slot");
const on = rule(".ts-tabs .ts-tab-slot[data-on]");
const button = rule(".ts-tabs .ts-tab");
const says = rule(".ts-tab-in");
const word = rule(".ts-tab-word");
const name = rule(".wsp-tab-name");
const px = (v: string | undefined) => Number(/^(\d+)px$/.exec(v ?? "")?.[1]);

describe("a tab's words stay inside the tab", () => {
  it("clips what a tab holds, so a squeezed tab paints nothing over its neighbour", () => {
    expect(decl(tab, "overflow")).toBe("hidden");
    expect(decl(tab, "min-width")).toBe("64px");
  });

  it("has the tab fill its slot and give way with it, clipping what it holds too", () => {
    expect(decl(button, "flex")).toBe("1 1 auto");
    expect(decl(button, "min-width")).toBe("0");
    // .wsp-tab's own 220 cap would hold the tab on show under its slot's 240.
    expect(decl(button, "max-width")).toBe("none");
    expect(decl(button, "overflow")).toBe("hidden");
    expect(decl(button, "padding")).toBe("0 8px");
    // And what it says fills the tab in turn, its words 6px apart as before.
    expect(decl(says, "flex")).toBe("1 1 auto");
    expect(decl(says, "min-width")).toBe("0");
    expect(decl(says, "gap")).toBe("6px");
  });

  it("lets the state word shrink to an ellipsis and to nothing, as the name can", () => {
    expect(decl(word, "min-width")).toBe("0");
    expect(decl(word, "overflow")).toBe("hidden");
    expect(decl(word, "text-overflow")).toBe("ellipsis");
    expect(decl(word, "white-space")).toBe("nowrap");
    expect(decl(name, "min-width")).toBe("0");
    expect(decl(name, "text-overflow")).toBe("ellipsis");
    // CHANGED ON PURPOSE: the word was `flex: none` and never shrank.
    expect(decl(word, "flex")).not.toBe("none");
  });

  // The tab's own room: its 8px padding either side, the 14px glyph, and the
  // 6px gaps before the name and before the word (.ts-tab-in).
  const fixed = 2 * 8 + 14 + 2 * 6;
  const fit = (tabW: number, nameW: number, wordW: number) => {
    const [n, w] = shrinkLine(tabW - fixed, [
      { basis: nameW, shrink: shrinkOf(name), min: 0 },
      { basis: wordW, shrink: shrinkOf(word), min: 0 },
    ]);
    return { name: n!, word: w! };
  };

  it("gives way with the state word first: the name keeps its width until the word is gone", () => {
    expect(shrinkOf(word)).toBeGreaterThanOrEqual(100 * shrinkOf(name));
    // "Fix login" (50px) and "ended 17m ago" (80px), the tab ever narrower.
    expect(fit(200, 50, 80)).toEqual({ name: 50, word: 80 });
    for (const w of [150, 120, 95]) {
      const got = fit(w, 50, 80);
      expect(got.name, `${w}px tab`).toBeGreaterThan(49.5);
      expect(got.word, `${w}px tab`).toBeLessThan(80);
    }
    const gone = fit(90, 50, 80);
    expect(gone.word).toBe(0);
    expect(gone.name).toBeCloseTo(48, 0);
  });

  it("fits a long name and its word in the 64px floor, with nothing left over to spill", () => {
    const got = fit(px(decl(tab, "min-width")), 340, 75);
    expect(got.word).toBe(0);
    expect(got.name + got.word).toBeLessThanOrEqual(px(decl(tab, "min-width")) - fixed + 0.01);
  });
});

describe("the tab on show", () => {
  it("is as wide as its words, up to 240 or the strip's width, never wider than the strip", () => {
    // CHANGED ON PURPOSE: `min-width: max-content` made it wider than a narrow
    // strip, whose edge then cut its name ("Migrate authe", "F").
    expect(on).not.toMatch(/max-content/);
    expect(decl(on, "max-width")).toBe("min(240px, 100%)");
    expect(decl(on, "flex")).toBe("none");
  });
});

describe("a narrow header with tabs", () => {
  const props = (tabs?: PaneTabsView): StageHeaderProps => ({
    identity: "session:s1", name: "api refactor", provider: "claude", workspace: "pane", split: true,
    status: { state: "idle", phrase: "idle" }, keysOwner: "pane", chordLabel: "Ctrl+Shift+X",
    canType: true, expanded: false, takeover: false, context: { used: 20_000, window: 200_000 },
    onKeys() {}, onExpand() {}, onClose() {}, ...(tabs ? { tabs } : {}),
  });
  const view: PaneTabsView = {
    items: [
      { key: "s:s1", id: "wsp-ptab-p0-s:s1", name: "api refactor", status: { state: "idle", phrase: "idle" }, on: true },
      { key: "s:s2", id: "wsp-ptab-p0-s:s2", name: "docs pass", status: { state: "ended", phrase: "ended 2m ago" }, on: false },
    ],
    onSelect() {},
    onClose() {},
  };

  it("gives the strip the context chip's room, and only a header with tabs", () => {
    const narrow = /@container ts-head \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.ts-head:has\(> \.ts-id\[data-tabs\]\) > \.ts-ctxchip \{ display: none; \}/);
    const tabbed = renderToStaticMarkup(createElement(StageHeader, props(view)));
    const one = renderToStaticMarkup(createElement(StageHeader, props()));
    expect(tabbed).toMatch(/<div class="ts-id" data-tabs="">/);
    expect(one).toMatch(/<div class="ts-id">/);
    // The chip is still drawn, so a wider header keeps it.
    expect(tabbed).toContain('class="ts-ctxchip"');
  });
});

describe("the tab the strip keeps in view", () => {
  type Fake = { id: string; closest(sel: string): Fake | null };
  const el = (id: string, inTab?: Fake): Fake => ({ id, closest: sel => (sel === "[role=tab]" ? inTab ?? null : null) });
  const shown = el("shown");
  shown.closest = () => shown;
  const other = el("other");
  other.closest = () => other;
  const strip = (tabs: Fake[]) => ({
    contains: (n: unknown) => tabs.includes(n as Fake),
    querySelector: (sel: string) => (sel === "[role=tab][aria-selected=true]" ? shown : null),
  }) as unknown as Element;
  const of = (s: Element, a: Fake | null) => (tabInView(s, a as unknown as Element) as unknown as Fake | null)?.id;

  it("is the tab under the keyboard while the keyboard is on this strip, else the tab on show", () => {
    expect(of(strip([shown, other]), other)).toBe("other");
    expect(of(strip([shown, other]), el("name", other)), "the keyboard on a word inside the tab").toBe("other");
    expect(of(strip([shown, other]), null), "the keyboard left the strip").toBe("shown");
    expect(of(strip([shown, other]), el("terminal")), "the keyboard in the terminal").toBe("shown");
    expect(of(strip([shown]), other), "a tab of another pane's strip").toBe("shown");
  });

  it("scrolls the strip just enough to show it, and a tab wider than the strip from its start", () => {
    const s = { left: 100, right: 280 };
    expect(revealBy(s, { left: 120, right: 260 })).toBe(0);
    expect(revealBy(s, { left: 166, right: 346 }), "cut by the right edge").toBe(66);
    expect(revealBy(s, { left: 40, right: 104 }), "cut by the left edge").toBe(-60);
    expect(revealBy(s, { left: 140, right: 400 }), "wider than the strip").toBe(40);
  });
});
