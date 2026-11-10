// The colour a machine meter's fill takes: the cores' --accent below 90, --err
// from 90, never amber. CHANGED ON PURPOSE (design recommendations, 2026-11-09):
// the 70-89 band in --text read as neither normal nor a warning, and the 2px
// line it filled was hard to see; the meter is an 8px bar now. The CPU has no
// meter at all: a build at 90% CPU is doing its job, so its total is a figure
// and its cores are columns in the accent, which take no level. The level
// follows the figure as it is printed, so 89.6, which reads "90%", is coloured
// as 90.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { declared, sheetRules } from "./sheet-cascade";

import type { Snapshot } from "../machine-snapshot";

const GIB = 1024 ** 3;
const snap = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-system", () => ({ useSystem: () => snap.current }));

const { Meter, meterLevel } = await import("../components/MachineReadout");
const { default: MachinePanel } = await import("../components/MachinePanel");

const machine = (over: Partial<Snapshot>): Snapshot => ({
  ok: true,
  cpu: 50,
  cpuHistory: [],
  cores: 4,
  memory: { total: 32 * GIB, available: 16 * GIB, usedPct: 50 },
  swap: { total: 4 * GIB, used: 1 * GIB },
  perCore: [10, 20, 30, 40],
  uptimeSec: 3600,
  platform: "linux",
  loadavg: [1, 1, 1],
  thermal: null,
  network: null,
  intervalMs: 3000,
  ...over,
});

const draw = (s: Snapshot) => {
  snap.current = s;
  return renderToStaticMarkup(createElement(MachinePanel, { usageOpen: false, onClose: () => {} }));
};
/** The data-level of every fill with this class, in the order drawn. */
const levels = (html: string, cls: "sd-fill" | "sd-core-fill") =>
  [...html.matchAll(new RegExp(`class="${cls}" data-level="(\\w+)"`, "g"))].map(m => m[1]);

describe("meterLevel", () => {
  it("is the accent below 90 and --err from 90, with no step between", () => {
    expect(meterLevel(0)).toBe("accent");
    expect(meterLevel(69)).toBe("accent");
    expect(meterLevel(70)).toBe("accent");
    expect(meterLevel(89)).toBe("accent");
    expect(meterLevel(90)).toBe("err");
  });

  it("is the same rule for every meter: there is no meter that cannot alarm", () => {
    // CHANGED ON PURPOSE: the one reading that never alarmed, the CPU's total
    // meter, is gone (the total is a figure), so the switch that kept it off
    // --err went with it.
    expect(meterLevel.length).toBe(1);
    expect(meterLevel(100)).toBe("err");
  });
});

describe("a meter takes its level from the rounded figure", () => {
  it("colours 89.6, which reads 90%, as 90", () => {
    expect(renderToStaticMarkup(createElement(Meter, { pct: 89.6 }))).toContain('data-level="err"');
    expect(renderToStaticMarkup(createElement(Meter, { pct: 89.4 }))).toContain('data-level="accent"');
  });
});

describe("a meter is a bar the eye finds without reading the figure", () => {
  /** The last declaration of `prop` on exactly this selector, outside any @media. */
  const decl = (selector: string, prop: string): string | undefined => {
    let found: string | undefined;
    for (const r of sheetRules()) {
      if (r.media !== null || !r.selectors.includes(selector)) continue;
      found = declared(r.body, prop) ?? found;
    }
    return found;
  };

  it("is 8 high with the cores' 2px corners, on the track token", () => {
    expect(decl(".sd-track", "height")).toBe("8px");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): the cores' corners are the control's.
    expect(decl(".sd-core", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".sd-track", "border-radius")).toBe(decl(".sd-core", "border-radius"));
    expect(decl(".sysdetail .sd-fill", "border-radius")).toBe(decl(".sd-core", "border-radius"));
    expect(decl(".sd-track", "background")).toBe("var(--ctl-fill)");
  });

  it("fills in the cores' accent, turns --err only at the alarm level, and has no level between", () => {
    expect(decl(".sysdetail .sd-fill", "background")).toBe("var(--accent)");
    expect(decl(".sysdetail .sd-fill", "background")).toBe(decl(".sysdetail .sd-core-fill", "background"));
    expect(decl('.sysdetail .sd-fill[data-level="err"]', "background")).toBe("var(--err)");
    expect(sheetRules().some(r => r.selectors.some(s => s.includes('.sd-fill[data-level="text"]')))).toBe(false);
  });
});

describe("the machine panel's meters", () => {
  const hot = draw(machine({ cpu: 95, perCore: [95, 99.6, 89.6, 69.6, 20], memory: { total: 32 * GIB, available: 2 * GIB, usedPct: 95 } }));

  it("draws no meter for the CPU and no level on any core, so nothing there turns --err", () => {
    // CHANGED ON PURPOSE (the owner prefers main's columns): the total is the
    // figure beside the heading and each core is an accent column, so a CPU at
    // 95% has neither a --text nor an --err fill anywhere in its block.
    const cpu = hot.slice(hot.indexOf('data-group="cores"'), hot.indexOf('data-group="load"'));
    expect(cpu).toContain(">95%<");
    expect(cpu).not.toContain("sd-track");
    expect(cpu).not.toContain("data-level");
    expect((cpu.match(/class="sd-core-fill"/g) ?? []).length).toBe(5);
    expect(levels(hot, "sd-core-fill")).toEqual([]);
  });

  it("gives memory the full thresholds, so 95% is --err", () => {
    // Order drawn: physical memory, swap (the CPU drew the first meter once).
    expect(levels(hot, "sd-fill")).toEqual(["err", "accent"]);
  });
});
