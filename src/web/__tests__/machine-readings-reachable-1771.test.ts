// A screen reader heard none of the machine panel's readings (#1771).
//
// Each section — CPU, Load average, Memory, Network, Thermal — was one history
// button wrapped around every reading in it, and the button carried an
// `aria-label`. A button's accessible name is its label and its contents are
// presentational, so NVDA, JAWS and VoiceOver said "Show memory history,
// button" and nothing else: not "20.5 GB of 32.0 GB", not what was available,
// not the temperatures, the throttle row, the load figures or "Can’t reach
// Claude". And three of those names left out the words on screen (WCAG 2.5.3),
// so "click Busiest processes" matched nothing.
//
// The heading row is the button now and the readings follow it as ordinary
// content. Run, not read: the components are drawn by react-dom/server with a
// snapshot this file chooses, and the markup is checked the way a reader meets
// it — every figure either outside every button, or inside one whose name says
// it.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Snapshot } from "../machine-snapshot";

const GIB = 1024 ** 3;
const snap = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-system", () => ({ useSystem: () => snap.current }));

const { Fig, OpensHistory, Row } = await import("../components/MachineReadout");
const { default: MachinePanel } = await import("../components/MachinePanel");
const { fmtBytes } = await import("../byte-format");

/** Every button in the markup, with where it starts and ends and its name.
 *  None nest: a button cannot contain one. */
function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
    start: m.index!,
    end: m.index! + m[0].length,
    attrs: m[1],
    inner: m[2],
    name: /aria-label="([^"]*)"/.exec(m[1])?.[1] ?? null,
  }));
}

/** Where `figure` is drawn and a screen reader cannot reach it: inside a
 *  button whose name does not say it. Empty is the answer wanted. */
function unreachable(html: string, figure: string): string[] {
  const found: string[] = [];
  let at = html.indexOf(figure);
  if (at < 0) throw new Error(`"${figure}" is not in the markup at all`);
  const bs = buttons(html);
  for (; at >= 0; at = html.indexOf(figure, at + 1)) {
    const b = bs.find(x => at > x.start && at < x.end);
    if (b && !(b.name ?? "").includes(figure)) found.push(`inside the button named "${b.name}"`);
  }
  return found;
}

const opens = (props: { group: "memory" | "network"; title: string; action: string; label: string }, child: React.ReactNode) =>
  renderToStaticMarkup(createElement(OpensHistory, props, child));

describe("a section's readings", () => {
  it("are outside the history button, so the memory figures are read", () => {
    const html = opens(
      { group: "memory", title: "Memory history", action: "Show memory history", label: "Memory" },
      createElement(Row, { label: "Physical", value: "20.5 GB of 32.0 GB", pct: 64, note: "11.5 GB available" }),
    );
    expect(unreachable(html, "20.5 GB of 32.0 GB")).toEqual([]);
    expect(unreachable(html, "11.5 GB available")).toEqual([]);
  });

  it("are outside it for the network figures too", () => {
    const html = opens(
      { group: "network", title: "Network history", action: "Show network history", label: "Network" },
      createElement(Fig, { value: "1.2", unit: "MB/s", cap: "Download" }),
    );
    expect(unreachable(html, "Download")).toEqual([]);
    expect(unreachable(html, "MB/s")).toEqual([]);
  });
});

describe("the whole panel, drawn from one snapshot", () => {
  const machine: Snapshot = {
    ok: true,
    cpu: 37,
    cpuHistory: [],
    cores: 4,
    memory: { total: 32 * GIB, available: 11.5 * GIB, usedPct: 64 },
    swap: { total: 4 * GIB, used: 1 * GIB },
    perCore: [10, 98, 30, 20],
    uptimeSec: 3600,
    platform: "linux",
    loadavg: [6.2, 3.1, 1.5],
    thermal: {
      celsius: [{ label: "Package id 0", celsius: 58, warnAt: 75, critAt: 90 }],
      throttle: { speedLimit: 80 },
      heldBack: null,
    },
    network: { down: 1_200_000, up: 45_000, api: { host: "api.anthropic.com", ms: null }, route: null },
    intervalMs: 3000,
  };
  snap.current = machine;
  const html = renderToStaticMarkup(createElement(MachinePanel, { usageOpen: false, onClose: () => {} }));

  it("lets every reading be heard where it is drawn", () => {
    const figures = [
      // CPU: the strip's one name for all its columns.
      "4 logical cores, busiest at 98%",
      // Load average, and the sentence that only appears past the core count.
      "6.20", "3.10", "1.50", "1.6× more work queued than cores to run it",
      // Memory.
      fmtBytes(32 * GIB - 11.5 * GIB), `of ${fmtBytes(32 * GIB)}`, `${fmtBytes(11.5 * GIB)} available`, "Swap",
      // Network, and the one state of it that is a fault.
      "Download", "Upload", "Can’t reach Claude",
      // Thermal: the sensor, the bar in words, and the throttle row.
      "Package id 0", "58 °C on a bar that runs to 90 °C, amber from 75 °C", "Throttling",
      "CPU held to 80% of full speed to cool down",
    ];
    for (const f of figures) expect(unreachable(html, f), f).toEqual([]);
  });

  it("names every control with the words it shows", () => {
    // SC 2.5.3: the name contains the visible label, so a voice-control user
    // who says what they see reaches the control.
    const opens = buttons(html).filter(b => /class="[^"]*\bsd-open\b/.test(b.attrs));
    const seen = opens.map(b => {
      const visible = (/class="(?:sd-h|sd-door-name)"[^>]*>([^<]*)/.exec(b.inner)?.[1] ?? "").trim();
      return { visible, name: b.name };
    });
    // Six, so a sweep that found nothing cannot pass for one that found them all.
    expect(seen.map(s => s.visible)).toEqual(["CPU", "Load average", "Memory", "Network", "Thermal", "Busiest processes"]);
    for (const { visible, name } of seen) {
      if (name == null) continue;
      expect(name.toLowerCase(), visible).toContain(visible.toLowerCase());
    }
    // And the door's name leads with its label rather than burying it.
    expect(seen.at(-1)!.name ?? "Busiest processes").toMatch(/^Busiest processes/);
  });
});
