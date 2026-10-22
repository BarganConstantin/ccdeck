// One freshness line for every integration panel (#2178, #2179). Jira's
// toolbar said "Updated just now" after a refresh that had failed, so the rows
// it kept on screen were claimed as fresh; the forges said "Not updated · last
// answer …". IntegrationFreshness is the forges' honest line made shared: this
// holds its words for each state, that a failure is a mark and a word in
// --warn, that Refresh spins only while a read is out and never under reduced
// motion, and that the line a screen reader is told about changes on a
// transition, not on every tick of the age.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationFreshness, { freshnessWords } from "../components/IntegrationFreshness";
import { sheetText } from "./sheet-source";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const render = (props: Partial<Parameters<typeof IntegrationFreshness>[0]>) =>
  renderToStaticMarkup(createElement(IntegrationFreshness, {
    loadedAt: null, loading: false, onRefresh: () => {}, label: "Refresh the board", now: NOW, ...props,
  }));
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("the freshness line's words", () => {
  it("says nothing before the first read is asked for", () => {
    expect(freshnessWords({ loadedAt: null, loading: false }, NOW)).toMatchObject({ tone: "none", text: "" });
  });

  it("reads, then updates, then says how old the answer is", () => {
    expect(freshnessWords({ loadedAt: null, loading: true }, NOW).text).toBe("Reading…");
    expect(freshnessWords({ loadedAt: NOW - 5 * MIN, loading: true }, NOW).text).toBe("Updating…");
    expect(freshnessWords({ loadedAt: NOW - 20_000, loading: false }, NOW).text).toBe("Updated just now");
    expect(freshnessWords({ loadedAt: NOW - 5 * MIN, loading: false }, NOW).text).toBe("Updated 5m ago");
  });

  it("never calls a kept answer fresh after a read that failed", () => {
    const words = freshnessWords({ loadedAt: NOW - 12 * MIN, loading: false, stale: true }, NOW);
    expect(words).toMatchObject({ tone: "stale", word: "Not updated", text: "Not updated · last answer 12m ago" });
    // A failure before any answer has nothing to be stale against; the panel's failure note says it.
    expect(freshnessWords({ loadedAt: null, loading: false, stale: true }, NOW).tone).toBe("none");
  });
});

describe("the freshness line on screen", () => {
  it("puts the warning mark beside its word, and the exact moment behind the age", () => {
    const html = render({ loadedAt: NOW - 12 * MIN, stale: true });
    expect(html).toMatch(/data-tone="stale"/);
    expect(html).toMatch(/<svg class="ig-mark"[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="ig-fresh-word">Not updated<\/span> · last answer <time dateTime="2026-10-22T11:48:00.000Z" title="[^"]+">12m ago<\/time>/);
  });

  it("names Refresh for what it reads, and keeps it out of a second read while one is out", () => {
    const idle = render({ loadedAt: NOW - MIN });
    expect(idle).toMatch(/<button type="button" class="glyph-btn ig-refresh" aria-label="Refresh the board" title="Refresh" aria-busy="false">/);
    // Busy, not disabled: focus stays on the button a press came from (#518).
    const busy = render({ loadedAt: NOW - MIN, loading: true });
    expect(busy).toMatch(/aria-busy="true" data-loading="true"/);
    expect(busy).not.toMatch(/ disabled=""/);
    expect(render({ disabled: true })).toMatch(/ disabled=""/);
  });

  it("tells a screen reader the transition, not the ticking age", () => {
    expect(render({ loadedAt: NOW - MIN })).toContain('<span class="vis-hidden" role="status"></span>');
    expect(render({ loadedAt: NOW - MIN, loading: true })).toContain('<span class="vis-hidden" role="status">Updating…</span>');
    // The visible line, whose age moves every minute, is not itself live.
    expect(render({ loadedAt: NOW - MIN })).not.toMatch(/class="ig-fresh"[^>]*(role|aria-live)=/);
  });

  it("spins Refresh only while a read is out, and not at all under reduced motion", () => {
    const spins = [...css.matchAll(/([^{}]+)\{[^}]*animation:\s*ta-spin[^}]*\}/g)].map(m => m[1].trim()).filter(s => s.includes("ig-refresh"));
    expect(spins).toEqual([".ig-refresh[data-loading] svg"]);
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(reduced).toMatch(/\.ig-refresh\[data-loading\] svg\s*\{\s*animation:\s*none/);
  });

  it("says Not updated in --warn, mark and word, and keeps the rest of the line quiet", () => {
    expect(css).toMatch(/\.ig-freshness\[data-tone="stale"\] \.ig-fresh-word,\s*\.ig-freshness\[data-tone="stale"\] \.ig-mark\s*\{\s*color:\s*var\(--warn\)/);
    expect(css).toMatch(/\.ig-fresh\s*\{[^}]*color:\s*var\(--muted\)[^}]*text-overflow:\s*ellipsis|\.ig-fresh\s*\{[^}]*text-overflow:\s*ellipsis[^}]*color:\s*var\(--muted\)/);
  });
});
