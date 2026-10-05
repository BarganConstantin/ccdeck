// Double-clicking a figure in the machine panel, to select and copy it, opened
// that section's history and closed it again.
//
// A press anywhere on a section's readings opens its chart, and a drag that
// ends with a figure selected does not (machine-reading-press.test.ts). But a
// double-click selects its word on the SECOND press, and the first press's
// click had already arrived with nothing selected — so it opened the history,
// whose backdrop then took the second press and closed it. Nothing was
// selected, and the dialog flashed. A triple-click, to take a whole line, did
// the same.
//
// Now a press on the readings opens the chart once it is plainly one press:
// the second press of a double-click calls the first one's off.
//
// Run, not read: OpensHistory is drawn on fake-react.ts's React, and a click is
// delivered the way the document delivers one, to the element under the
// pointer and then to each of its ancestors — carrying the click count the
// browser gives it as `detail`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsx } from "react/jsx-runtime";

import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const { OpensHistory } = await import("../components/MachineReadout");
const { default: SectionHistoryModal } = await import("../components/SectionHistoryModal");

/** What `window.getSelection()` answers. A double-click's second press is the
 *  one that selects the word under it. */
let selection: { isCollapsed: boolean };

beforeEach(() => {
  vi.useFakeTimers();
  selection = { isCollapsed: true };
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

/** The memory section's block, with one figure in it. */
function memory() {
  const view = mount(OpensHistory, {
    group: "memory", title: "Memory", action: "Show memory history", label: "Memory",
    children: jsx("span", { className: "sd-fig", children: jsx("b", { children: "20.5 GB" }) }),
  });
  return {
    view,
    get figure() { return one(view.tree, el => el.type === "b")!; },
    get heading() { return one(view.tree, el => el.type === "button")!; },
    get opened() { return one(view.tree, el => el.type === SectionHistoryModal) != null; },
  };
}

/** The elements from the root down to `target`. */
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

/** One click on `target`, the `detail`-th of its gesture. */
function click(tree: unknown, target: Drawn, detail: number) {
  let stopped = false;
  const e = { target, detail, stopPropagation: () => { stopped = true; }, preventDefault: () => {} };
  for (const el of pathTo(tree, target)!.reverse()) {
    (el.props.onClick as ((ev: typeof e) => void) | undefined)?.(e);
    if (stopped) break;
  }
}

describe("a figure in the machine panel", () => {
  it("is selected by a double-click, and no history opens", () => {
    const block = memory();
    click(block.view.tree, block.figure, 1);
    vi.advanceTimersByTime(120);
    click(block.view.tree, block.figure, 2);
    selection = { isCollapsed: false };
    vi.advanceTimersByTime(2_000);
    expect(block.opened).toBe(false);
  });

  it("is selected by a triple-click, a line at a time, and no history opens", () => {
    const block = memory();
    click(block.view.tree, block.figure, 1);
    vi.advanceTimersByTime(110);
    click(block.view.tree, block.figure, 2);
    selection = { isCollapsed: false };
    vi.advanceTimersByTime(110);
    click(block.view.tree, block.figure, 3);
    vi.advanceTimersByTime(2_000);
    expect(block.opened).toBe(false);
  });

  it("still opens the history from a single press", () => {
    const block = memory();
    click(block.view.tree, block.figure, 1);
    vi.advanceTimersByTime(2_000);
    expect(block.opened).toBe(true);
  });

  it("leaves the heading opening it at once, a keyboard's press and a pointer's alike", () => {
    for (const detail of [0, 1]) {
      const block = memory();
      click(block.view.tree, block.heading, detail);
      expect(block.opened, `detail ${detail}`).toBe(true);
    }
  });
});
