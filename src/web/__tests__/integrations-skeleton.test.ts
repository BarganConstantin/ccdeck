// One loading shape for every integration panel (#2178, #2179). Jira's bars
// pulsed every 900 ms and the forges' every 1200 ms, and the forges' kept
// pulsing under reduced motion. IntegrationSkeleton is one shape: hidden for
// the first 300 ms so a quick read never flashes it, then the deck's one
// ambient pulse (--pulse-live), and no pulse at all under reduced motion.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationSkeleton from "../components/IntegrationSkeleton";
import { sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

describe("the integrations' loading rows", () => {
  it("tells a screen reader what is being read, once, and hides the bars from it", () => {
    const html = renderToStaticMarkup(createElement(IntegrationSkeleton, { label: "Reading the board", rows: 3 }));
    expect(html).toBe('<div class="ig-skeleton" data-variant="rows" role="status"><span class="vis-hidden">Reading the board</span>'
      + '<i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i></div>');
  });

  it("stays out of sight for 300 ms, then fades in", () => {
    expect(rule(".ig-skeleton")).toMatch(/animation:\s*fadeIn var\(--dur-fast\) var\(--ease\) 300ms both/);
  });

  it("pulses at the deck's one ambient beat, and not at all under reduced motion", () => {
    expect(rule(".ig-skeleton i")).toMatch(/animation:\s*ta-pulse var\(--pulse-live\) infinite alternate/);
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(reduced).toMatch(/\.ig-skeleton i\s*[,{][^}]*animation:\s*none/);
  });

  it("keeps an edge under a Contrast theme, which drops the bars' fill", () => {
    expect(rule(".ig-skeleton i")).toMatch(/outline:\s*1px solid transparent/);
  });
});
