// The colour a machine meter's fill takes: under 70 --muted, 70 to 89 --text,
// 90 and up --err, never amber. The CPU and every per-core meter are the one
// exception to the top step: a build at 90% CPU is doing its job, so they stop
// at --text. The level follows the figure as it is printed, so 89.6, which
// reads "90%", is coloured as 90.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
  it("steps at 70 and at 90", () => {
    expect(meterLevel(69)).toBe("muted");
    expect(meterLevel(70)).toBe("text");
    expect(meterLevel(89)).toBe("text");
    expect(meterLevel(90)).toBe("err");
  });

  it("never reaches --err when the reading does not alarm", () => {
    expect(meterLevel(69, false)).toBe("muted");
    expect(meterLevel(70, false)).toBe("text");
    expect(meterLevel(100, false)).toBe("text");
  });
});

describe("a meter takes its level from the rounded figure", () => {
  it("colours 89.6, which reads 90%, as 90", () => {
    expect(renderToStaticMarkup(createElement(Meter, { pct: 89.6 }))).toContain('data-level="err"');
    expect(renderToStaticMarkup(createElement(Meter, { pct: 89.4 }))).toContain('data-level="text"');
  });
});

describe("the machine panel's meters", () => {
  const hot = draw(machine({ cpu: 95, perCore: [95, 99.6, 89.6, 69.6, 20], memory: { total: 32 * GIB, available: 2 * GIB, usedPct: 95 } }));

  it("gives the CPU meter and every core --text at the top, never --err", () => {
    const [cpu] = levels(hot, "sd-fill");
    expect(cpu).toBe("text");
    expect(levels(hot, "sd-core-fill")).toEqual(["text", "text", "text", "text", "muted"]);
  });

  it("gives memory the full thresholds, so 95% is --err", () => {
    // Order drawn: CPU, physical memory, swap.
    expect(levels(hot, "sd-fill")).toEqual(["text", "err", "muted"]);
  });
});
