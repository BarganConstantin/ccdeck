// A press on the machine panel's readings stopped opening their history.
//
// The Load average block — "LOAD AVERAGE ›", three figures, and "4.0× more
// work queued than cores to run it" under them once the queue outgrows the
// cores — opened the load chart from anywhere in it, and so did every other
// section of the panel. #1771 took the readings out of the history button so a
// screen reader could hear them, and the block's press went with them: only
// the heading row answered after that, and a press on the figures or on the
// sentence, where the eye already is, did nothing at all.
//
// Both are kept here, and neither at the other's cost. The block takes the
// press again; the heading is still its one control, named with its visible
// words, and the readings are still ordinary content outside it.
//
// Run, not read: MachinePanel is drawn on fake-react.ts's React from one
// snapshot, each section and its history control are run the same way, and a
// press is delivered the way the document delivers a click — to the element
// under the pointer, then to each of its ancestors in turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../machine-snapshot";
import { all, mount, one, textOf, type Drawn } from "./fake-react";
import { sheetText } from "./sheet-source";

vi.mock("react", async () => (await import("./fake-react")).react);
const snap = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-system", () => ({ useSystem: () => snap.current }));

const { default: MachinePanel } = await import("../components/MachinePanel");
const { OpensHistory } = await import("../components/MachineReadout");
const { default: SectionHistoryModal } = await import("../components/SectionHistoryModal");

const GIB = 1024 ** 3;
/** Twelve cores and a queue four times their number, the owner's own reading:
 *  the sentence under the figures is only drawn once the queue exceeds them. */
const MACHINE: Snapshot = {
  ok: true,
  cpu: 96,
  cpuHistory: [],
  cores: 12,
  memory: { total: 32 * GIB, available: 11.5 * GIB, usedPct: 64 },
  swap: { total: 4 * GIB, used: 1 * GIB },
  perCore: [90, 98, 97, 95, 99, 94, 96, 93, 97, 98, 92, 99],
  uptimeSec: 3600,
  platform: "linux",
  loadavg: [48.34, 43.53, 35.29],
  thermal: {
    celsius: [{ label: "Package id 0", celsius: 58, warnAt: 75, critAt: 90 }],
    throttle: { speedLimit: 80 },
    heldBack: null,
  },
  network: { down: 1_200_000, up: 45_000, api: { host: "api.anthropic.com", ms: 42 }, route: null },
  intervalMs: 3000,
};

type HistoryProps = Parameters<typeof OpensHistory>[0];
type Press = { target: Drawn; detail: number; stopPropagation(): void; preventDefault(): void };

/** The heading button's node, which is all the block asks of it. */
let focused: string[];
/** What `window.getSelection()` answers: a press that ends a drag across a
 *  figure leaves some of it selected. */
let selection: { isCollapsed: boolean };

beforeEach(() => {
  focused = [];
  selection = { isCollapsed: true };
  // A press on the readings waits out a double-click before it opens the
  // chart (machine-reading-double-click.test.ts), on the window's clock.
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    getSelection: () => selection,
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Every section's history control, each mounted on its own the way React
 *  would mount it, keyed by the history it opens. */
function controls(snapshot: Snapshot = MACHINE) {
  snap.current = snapshot;
  const panel = mount(MachinePanel, { usageOpen: false, onClose: () => {} });
  const sections = all(panel.tree, el => typeof el.type === "function" && /Section$/.test((el.type as { name: string }).name));
  const byGroup = new Map<string, ReturnType<typeof control>>();
  for (const section of sections) {
    const drawn = mount(section.type as (p: unknown) => unknown, section.props);
    for (const el of all(drawn.tree, e => e.type === OpensHistory)) {
      const props = el.props as unknown as HistoryProps;
      byGroup.set(props.group, control(props));
    }
  }
  return byGroup;
}

/** One history control, run, with its button's ref pointed at a node that
 *  records being focused. */
function control(props: HistoryProps) {
  const view = mount(OpensHistory, props, {
    commit: tree => {
      for (const b of all(tree, el => el.type === "button")) {
        if (b.ref && typeof b.ref === "object") {
          (b.ref as { current: unknown }).current = { focus: () => { focused.push(props.group); } };
        }
      }
    },
  });
  return {
    view,
    get opened() {
      return one(view.tree, el => el.type === SectionHistoryModal)?.props.group ?? null;
    },
  };
}

/** The elements from the root down to `target`, or null when it is not there. */
function pathTo(n: unknown, target: Drawn): Drawn[] | null {
  if (Array.isArray(n)) {
    for (const c of n) { const p = pathTo(c, target); if (p) return p; }
    return null;
  }
  if (!n || typeof n !== "object" || !("props" in n)) return null;
  const el = n as Drawn;
  if (el === target) return [el];
  const below = pathTo(el.props.children, target);
  return below ? [el, ...below] : null;
}

/** A pointer's click on `target`: its own handler, then every ancestor's,
 *  until one stops it — and then the moment a single press waits for. */
function press(tree: unknown, target: Drawn, detail = 1) {
  const path = pathTo(tree, target);
  if (!path) throw new Error("pressed something that is not drawn");
  let stopped = false;
  const e: Press = { target, detail, stopPropagation: () => { stopped = true; }, preventDefault: () => {} };
  for (const el of path.reverse()) {
    const onClick = el.props.onClick as ((e: Press) => void) | undefined;
    onClick?.(e);
    if (stopped) break;
  }
  vi.runOnlyPendingTimers();
}

const load = () => controls().get("load")!;
const figure = (tree: unknown, value: string) =>
  one(tree, el => typeof el.type === "function" && el.props.value === value)!;
const sentence = (tree: unknown) =>
  one(tree, el => el.type === "div" && textOf(el) === "4.0× more work queued than cores to run it")!;

describe("the Load average block opens the load history from anywhere in it", () => {
  it("draws the three figures and the sentence the owner reads", () => {
    const { view } = load();
    for (const v of ["48.34", "43.53", "35.29"]) expect(figure(view.tree, v), v).not.toBeNull();
    expect(sentence(view.tree)).not.toBeNull();
  });

  it("opens it from a press on each figure", () => {
    for (const v of ["48.34", "43.53", "35.29"]) {
      const block = load();
      press(block.view.tree, figure(block.view.tree, v));
      expect(block.opened, v).toBe("load");
    }
  });

  it("opens it from a press on the sentence under the figures", () => {
    const block = load();
    press(block.view.tree, sentence(block.view.tree));
    expect(block.opened).toBe("load");
  });

  it("still opens it from the heading, which is how a keyboard presses it", () => {
    const block = load();
    const heading = one(block.view.tree, el => el.type === "button")!;
    press(block.view.tree, heading, 0);
    expect(block.opened).toBe("load");
  });

  it("hands the heading the focus, so the dialog gives it back there on close", () => {
    // The whole block was a button, and a press on it focused it; the dialog
    // returns focus to whatever held it when it opened. A press on the
    // readings has to leave the heading holding it, or closing the chart drops
    // the keyboard at the top of the document.
    const block = load();
    press(block.view.tree, figure(block.view.tree, "48.34"));
    expect(focused).toEqual(["load"]);
  });

  it("leaves a drag that selected a figure as a selection, not a chart", () => {
    // The readings are ordinary text since #1771, so they can be selected and
    // copied. The click that ends such a drag is not a request for the chart.
    selection = { isCollapsed: false };
    const block = load();
    press(block.view.tree, figure(block.view.tree, "48.34"));
    expect(block.opened).toBeNull();
    expect(focused).toEqual([]);
  });

  it("is one control, named for its heading, with the readings outside it", () => {
    const { view } = load();
    const buttons = all(view.tree, el => el.type === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.title).toBe("Show load history");
    expect(buttons[0].props["aria-label"]).toBe("Load average: show history");
    // Nothing else in the block announces itself as a control or takes a Tab
    // stop: the press is the heading's, and the block only forwards it.
    expect(all(view.tree, el => "role" in el.props && el.props.role === "button")).toEqual([]);
    expect(all(view.tree, el => "tabIndex" in el.props)).toEqual([]);
    // #1771's half: the figures and the sentence are read where they are drawn.
    const inside = textOf(buttons[0]);
    for (const text of ["48.34", "1m", "4.0×"]) expect(inside, text).not.toContain(text);
  });
});

/** What a section draws under its heading: every element in the block but
 *  the heading's own button. */
const readingsIn = (tree: unknown) =>
  all(tree, el => el.props.className === "sd-reading")
    .flatMap(r => [r.props.children].flat(2))
    .filter((c): c is Drawn => !!c && typeof c === "object" && "props" in c && (c as Drawn).type !== "button");

describe("every section of the panel opens its history from its readings", () => {
  // The same change silenced all five, because all five are one component.
  it("opens each one from every reading drawn under its heading", () => {
    const groups = controls();
    // Five, so a panel that drew nothing cannot pass for one that drew all of it.
    expect([...groups.keys()].sort()).toEqual(["cores", "load", "memory", "network", "thermal"]);
    for (const [group, block] of groups) {
      const count = readingsIn(block.view.tree).length;
      expect(count, group).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const fresh = controls().get(group)!;
        press(fresh.view.tree, readingsIn(fresh.view.tree)[i]);
        expect(fresh.opened, `${group}, reading ${i + 1} of ${count}`).toBe(group);
      }
    }
  });
});

describe("the block lights and presses as one", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  /** A rule's body, anchored at a line start so one inside a media query is
   *  not read in its place. */
  const rule = (sel: string) => {
    const i = css.indexOf(`\n${sel} {`);
    return i < 0 ? "" : css.slice(i + 1, css.indexOf("}", i));
  };

  it("says it can be pressed anywhere in it", () => {
    expect(rule(".sysdetail .sd-reading")).toMatch(/cursor:\s*pointer/);
  });

  it("takes the band a section's heading takes, across the whole block", () => {
    const band = /background:\s*([^;]+);/.exec(rule(".sysdetail .sd-open:hover"))?.[1];
    expect(band).toBe("color-mix(in srgb, var(--text) 6%, transparent)");
    expect(rule(".sysdetail .sd-reading:hover")).toContain(`background: ${band}`);
  });

  it("presses at the 0.97 every labelled control in the panel presses at", () => {
    expect(rule(".sysdetail .sd-reading:active")).toMatch(/transform:\s*scale\(0\.97\)/);
  });
});
