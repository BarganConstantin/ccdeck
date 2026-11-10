// The CPU block of the This machine panel draws main's per-core columns under
// V4's heading: "CPU ›" and the total in mono, then one column per logical
// core, 28 high and 2 apart, an accent fill on a --line track with 2px corners,
// and an idle core keeps a 2px sliver. One row up to 32 cores, rows of 32 at
// 18 high after that, and a column is never wider than 24px. The total has no
// meter of its own; it is the figure beside the heading.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Snapshot } from "../machine-snapshot";
import { defaultReadingSheetText, sheetParts } from "./sheet-source";

const GIB = 1024 ** 3;
const snap = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-system", () => ({ useSystem: () => snap.current }));

const { default: MachinePanel } = await import("../components/MachinePanel");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(defaultReadingSheetText());
/** The panel's own part, for the colours a Contrast theme repaints later on. */
const panelCss = strip(sheetParts().find(([path]) => path === "styles/machine-panel.css")![1]);

/** The last value `prop` takes in a rule whose selector list holds `selector`. */
function decl(selector: string, prop: string, body = css): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!m[1].split(",").map(x => x.trim()).includes(selector)) continue;
    const d = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) out = d[1].trim();
  }
  return out;
}

/** Everything inside every `@media (hover: hover) and (pointer: fine)` block. */
const hoverBlocks = (() => {
  let out = "";
  for (const m of css.matchAll(/@media \(hover: hover\) and \(pointer: fine\)\s*\{/g)) {
    let depth = 0;
    for (let k = m.index! + m[0].length - 1; k < css.length; k++) {
      if (css[k] === "{") { depth++; if (depth === 1) continue; }
      else if (css[k] === "}") { depth--; if (!depth) break; }
      out += css[k];
    }
    out += "\n";
  }
  return out;
})();

const machine = (over: Partial<Snapshot>): Snapshot => ({
  ok: true,
  cpu: 22,
  cpuHistory: [],
  cores: 16,
  memory: { total: 64 * GIB, available: 23 * GIB, usedPct: 64 },
  swap: null,
  perCore: null,
  uptimeSec: 3600,
  platform: "linux",
  loadavg: [3.42, 2.87, 2.1],
  thermal: null,
  network: null,
  intervalMs: 3000,
  ...over,
});

const draw = (s: Snapshot) => {
  snap.current = s;
  return renderToStaticMarkup(createElement(MachinePanel, { usageOpen: false, onClose: () => {} }));
};
/** The CPU reading's own markup: from its block to the load average's. */
const cpuBlock = (html: string) => {
  const from = html.indexOf('data-group="cores"');
  const to = html.indexOf('data-group="load"');
  return from < 0 ? "" : html.slice(from, to < 0 ? undefined : to);
};
const cores = (n: number, at = (i: number) => (i * 37) % 101) => Array.from({ length: n }, (_, i) => at(i));

describe("the per-core columns' geometry", () => {
  it("draws each core as a column 28 high on a --line track with 2px corners", () => {
    expect(decl(".sd-core", "height")).toBe("28px");
    expect(decl(".sd-core", "background")).toBe("var(--line)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a column's corners are the control's.
    expect(decl(".sd-core", "border-radius")).toBe("var(--r-ctl)");
    // The track clips the fill, so a scaled fill keeps the column's corners.
    expect(decl(".sd-core", "overflow")).toBe("hidden");
  });

  it("sets the columns 2 apart and rows 4 apart, each column at most 24 wide", () => {
    expect(decl(".sd-cores", "display")).toBe("grid");
    expect(decl(".sd-cores", "gap")).toBe("4px 2px");
    // One row of implicit tracks, each between nothing and 24px: the row's
    // width is shared until every column reaches 24, so 4 cores stay columns
    // at the left instead of four wide blocks.
    expect(decl(".sd-cores", "grid-auto-flow")).toBe("column");
    expect(decl(".sd-cores", "grid-auto-columns")).toBe("minmax(0, 24px)");
    expect(decl(".sd-cores", "justify-content")).toBe("start");
  });

  it("wraps into rows of 32, 18 high, from the 33rd core on", () => {
    const many = ".sd-cores:has(> .sd-core:nth-child(33))";
    expect(decl(many, "grid-auto-flow")).toBe("row");
    expect(decl(many, "grid-template-columns")).toBe("repeat(32, minmax(0, 24px))");
    expect(decl(`${many} > .sd-core`, "height")).toBe("18px");
  });

  it("keeps a 2px sliver for an idle core at either column height", () => {
    expect(decl(".sd-core", "--core-floor")).toBe("calc(2 / 28)");
    expect(decl(".sd-cores:has(> .sd-core:nth-child(33)) > .sd-core", "--core-floor")).toBe("calc(2 / 18)");
    expect(decl(".sysdetail .sd-core-fill", "transform")).toBe("scaleY(clamp(var(--core-floor), var(--load, 0), 1))");
  });

  it("fills in the accent from the bottom, with no level colour", () => {
    expect(decl(".sysdetail .sd-core-fill", "background", panelCss)).toBe("var(--accent)");
    expect(decl(".sysdetail .sd-core-fill", "transform-origin")).toBe("bottom");
    expect(css).not.toMatch(/\.sd-core-fill\[data-level/);
  });

  it("dims the other columns while one is under the pointer, only where there is a pointer", () => {
    const rule = ".sysdetail .sd-cores:has(> .sd-core:hover) > .sd-core:not(:hover) > .sd-core-fill";
    expect(decl(rule, "opacity", hoverBlocks)).toBe("0.55");
  });

  it("puts the columns 8 under the heading, with no meter between them", () => {
    // The 3px the total meter sat under the heading is gone with the meter.
    expect(css).not.toMatch(/\.sd-reading\[data-group="cores"\] > \.sd-open \{/);
    expect(css).not.toMatch(/\.sd-track \+ \.sd-cores/);
    expect(decl(".sysdetail .sd-reading > .sd-open", "margin-bottom")).toBe("calc(8px - 4px)");
    // A heading alone keeps no gap under itself.
    expect(decl('.sysdetail .sd-reading[data-group="cores"] > .sd-open:last-child', "margin-bottom")).toBe("calc(0px - 4px)");
  });
});

describe("the CPU block in the panel", () => {
  it("draws one column per logical core under the heading and its total, and no total meter", () => {
    for (const n of [4, 12, 16, 32, 64]) {
      const block = cpuBlock(draw(machine({ cores: n, perCore: cores(n) })));
      expect((block.match(/class="sd-core"/g) ?? []).length, `${n} cores`).toBe(n);
      expect(block).toContain('<span class="sd-h-val">22%</span>');
      expect(block).not.toContain("sd-track");
    }
  });

  it("hands each column its reading as a share, and keeps the per-core tooltip", () => {
    const block = cpuBlock(draw(machine({ cores: 4, perCore: [0, 4, 50, 100] })));
    expect([...block.matchAll(/style="--load:([^"]+)"/g)].map(m => Number(m[1]))).toEqual([0, 0.04, 0.5, 1]);
    expect(block).toContain('title="logical core 4 · 100% busy"');
    expect(block).toContain('aria-label="4 logical cores, busiest at 100%"');
  });

  it("keeps the heading as the press that opens Core history", () => {
    const block = cpuBlock(draw(machine({ cores: 4, perCore: [10, 20, 30, 40] })));
    expect(block).toMatch(/<button type="button" class="sd-open" title="Show core history" aria-label="CPU: [^"]*22%[^"]*"/);
  });

  it("draws the total alone where the machine gives no per-core reading", () => {
    const block = cpuBlock(draw(machine({ cpu: 31, perCore: null })));
    expect(block).toContain('<span class="sd-h-val">31%</span>');
    expect(block).not.toContain("sd-cores");
    expect(block).not.toContain("sd-track");
  });

  it("still says it is reading this machine before the first reading", () => {
    const html = draw(machine({ cpu: null, perCore: null }));
    expect(cpuBlock(html)).toBe("");
    expect(html).toContain("reading this machine…");
  });
});
