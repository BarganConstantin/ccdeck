// How a banner comes and goes under the top bar (V4's motion rules). A banner
// used to appear with a fade and vanish in one frame, and the board under it
// jumped by its height both ways. Now every banner is drawn in one holder, the
// strip: in, its height and opacity over Base, as grid rows 0fr to 1fr; out,
// the same path over Exit, still drawn until it has gone. Reduced motion keeps
// the opacity and nothing else.
//
// Run, not read: the strip is called on fake-react.ts's React, and what it
// draws is read off the tree. The sheet's half is read off the stylesheet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mount, type Drawn } from "./fake-react";
import { sheetText } from "./sheet-source";

vi.mock("react", async () => (await import("./fake-react")).react);

const { BannerStrip } = await import("../components/DeckBanner");

type Props = { children: unknown };
const Strip = BannerStrip as unknown as (p: Props) => unknown;
const row = (words: string) => ({ type: "div", props: { className: "ver-banner", children: words } });
const strip = (tree: unknown) => tree as Drawn;
/** The row the strip holds. fake-react copies an element as it walks into its
 *  children, so a row is compared by what it is, not by identity. */
const inner =(tree: unknown) => (strip(tree).props.children as Drawn).props.children;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the strip a banner is drawn in", () => {
  it("draws nothing until there is a banner, then the row, open", () => {
    const view = mount(Strip, { children: null });
    expect(view.tree).toBeNull();
    const one = row("one");
    view.rerender({ children: one });
    expect(strip(view.tree).props.className).toBe("banner-strip");
    expect(strip(view.tree).props["data-open"]).toBe("");
    expect(strip(view.tree).props.inert).toBeUndefined();
    expect((strip(view.tree).props.children as Drawn).props.className).toBe("banner-strip-in");
    expect(inner(view.tree)).toEqual(one);
  });

  it("keeps the leaving row drawn, closed and inert, until its exit is over", () => {
    const one = row("one");
    const view = mount(Strip, { children: one });
    view.rerender({ children: null });
    expect(strip(view.tree).props["data-open"]).toBeUndefined();
    expect(strip(view.tree).props.inert).toBe("");
    expect(inner(view.tree)).toEqual(one);
    // Exit is 150ms, and every leaving surface waits a little past it in case
    // its transitionend never comes.
    vi.advanceTimersByTime(150 + 60 - 1);
    expect(view.tree).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(view.tree).toBeNull();
  });

  it("goes as soon as its own fade has ended, and not on a child's or on its height", () => {
    const view = mount(Strip, { children: row("one") });
    view.rerender({ children: null });
    const end = strip(view.tree).props.onTransitionEnd as (e: unknown) => void;
    const self = {};
    end({ target: {}, currentTarget: self, propertyName: "opacity" });
    expect(view.tree).not.toBeNull();
    end({ target: self, currentTarget: self, propertyName: "grid-template-rows" });
    expect(view.tree).not.toBeNull();
    end({ target: self, currentTarget: self, propertyName: "opacity" });
    expect(view.tree).toBeNull();
  });

  it("turns round when a banner is asked back while it leaves", () => {
    const view = mount(Strip, { children: row("one") });
    view.rerender({ children: null });
    const two = row("two");
    view.rerender({ children: two });
    expect(strip(view.tree).props["data-open"]).toBe("");
    expect(strip(view.tree).props.inert).toBeUndefined();
    expect(inner(view.tree)).toEqual(two);
    vi.advanceTimersByTime(1000);
    expect(inner(view.tree)).toEqual(two);
  });

  it("swaps one banner for the next in place, without closing", () => {
    const view = mount(Strip, { children: row("one") });
    const two = row("two");
    view.rerender({ children: two });
    expect(strip(view.tree).props["data-open"]).toBe("");
    expect(inner(view.tree)).toEqual(two);
  });
});

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (s: string) => s.replace(/\s+/g, " ");

describe("how the strip moves (V4's motion rules)", () => {
  it("is closed and clear by default, and leaves over Exit", () => {
    expect(squash(sheet)).toContain(".app > .banner-strip { grid-column: 1; grid-row: 2; display: grid; grid-template-rows: 0fr; opacity: 0; "
      + "transition: grid-template-rows var(--dur-exit) var(--ease), opacity var(--dur-exit) var(--ease); }");
  });

  it("opens its height and fades in over Base, from nothing", () => {
    expect(squash(sheet)).toContain(".app > .banner-strip[data-open] { grid-template-rows: 1fr; opacity: 1; transition-duration: var(--dur-base); }");
    expect(squash(sheet)).toMatch(/@starting-style \{ \.app > \.banner-strip\[data-open\] \{ grid-template-rows: 0fr; opacity: 0; \} \}/);
    expect(squash(sheet)).toContain(".banner-strip-in { min-height: 0; overflow: hidden; }");
  });

  it("takes no press while it leaves", () => {
    expect(squash(sheet)).toContain(".app > .banner-strip:not([data-open]) { pointer-events: none; }");
  });

  it("moves nothing but the opacity under reduced motion", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{ \.app > \.banner-strip \{ transition: opacity var\(--dur-exit\) var\(--ease\), grid-template-rows 0s var\(--ease\) var\(--dur-exit\); \} \.app > \.banner-strip\[data-open\] \{ transition: opacity var\(--dur-base\) var\(--ease\); \} @starting-style \{ \.app > \.banner-strip\[data-open\] \{ grid-template-rows: 1fr; \} \} \}/;
    expect(squash(sheet)).toMatch(reduced);
  });

  it("is what the deck draws every banner in", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/DeckBanner.tsx", import.meta.url), "utf8");
    expect(src).toContain("<BannerStrip>{row}</BannerStrip>");
  });
});
