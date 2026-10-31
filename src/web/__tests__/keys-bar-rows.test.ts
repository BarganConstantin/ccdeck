// The stage says how tall its keys bar is drawn, so the rows fit above it.
//
// On a screen under about 360px (touch) or 414px (mouse) the first-run line
// wraps to a third line and the bar grows from 36px to 51px until Got it is
// pressed. The rows were fitted to a 36px bar (stage-geometry.ts), so the
// grown bar covered up to 9px of the terminal's last row. The stage now
// watches its bar and hands its height up (onBarH); use-stage.ts gives it to
// the geometry, which fits the rows to what is left (stage-geometry.test.ts,
// use-stage.test.ts).
//
// The stage runs under fake-react with a fake bar and ResizeObserver; the
// document's part, attaching the stage's root, is played in `commit`.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { mount, one, type Drawn } from "./fake-react";
import TerminalStage, { type TerminalStageProps } from "../components/terminal/TerminalStage";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { SessionDeps } from "../use-terminal-session";

const geometry = stageGeometry({ appW: 320, bodyH: 540, cellW: 8, cellH: 18, expanded: false, narrow: true, storedCols: null });

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.ResizeObserver;
});

function stageWithBar(onBarH: (h: number) => void) {
  const g = globalThis as Record<string, unknown>;
  const body = { id: "body" };
  g.document = { body, activeElement: body };
  const watch = { callback: null as null | (() => void), watched: [] as unknown[], disconnected: 0 };
  g.ResizeObserver = class {
    constructor(fn: () => void) { watch.callback = fn; }
    observe(el: unknown) { watch.watched.push(el); }
    disconnect() { watch.disconnected += 1; }
  };
  /** The bar as the browser lays it out: 36px, until the line wraps. */
  const bar = { height: 36, getBoundingClientRect() { return { height: this.height }; } };
  const root = { contains: () => false, querySelector: (sel: string) => (sel === ".ts-bar" ? bar : null) };
  const deps: Partial<SessionDeps> = {
    api: { status: vi.fn(), open: vi.fn(), adopt: vi.fn(), launch: vi.fn() } as never,
    connect: vi.fn() as never,
    mount: vi.fn() as never,
    now: () => 0,
  };
  const props: TerminalStageProps = {
    show: { kind: "empty" }, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: true, asksWaiting: false,
    onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), onBarH, sessionDeps: deps,
  };
  const view = mount(TerminalStage, props, {
    commit: tree => {
      const section = one(tree, el => el.type === "section") as Drawn | null;
      const rootRef = section?.ref as { current: unknown } | undefined;
      if (rootRef && !rootRef.current) rootRef.current = root;
    },
  });
  return { view, bar, watch };
}

describe("the keys bar's height, as the stage draws it", () => {
  it("goes up once the stage is drawn, and again whenever the bar's size changes", () => {
    const onBarH = vi.fn();
    const s = stageWithBar(onBarH);
    expect(s.watch.watched, "the stage watches its own bar").toEqual([s.bar]);
    expect(onBarH).toHaveBeenLastCalledWith(36);

    // The first-run line wraps to a third line: 51px, said as drawn.
    s.bar.height = 51;
    s.watch.callback!();
    expect(onBarH).toHaveBeenLastCalledWith(51);

    // Got it: the bar is 36px again, and the rows can come back.
    s.bar.height = 36;
    s.watch.callback!();
    expect(onBarH).toHaveBeenLastCalledWith(36);
    s.view.unmount();
    expect(s.watch.disconnected, "and stops watching when the stage goes").toBe(1);
  });

  it("rounds a fraction of a pixel up, so no part of a row is ever left under the bar", () => {
    const onBarH = vi.fn();
    const s = stageWithBar(onBarH);
    s.bar.height = 50.4;
    s.watch.callback!();
    expect(onBarH).toHaveBeenLastCalledWith(51);
    // Layout's own rounding noise on an exact height is not a pixel more.
    s.bar.height = 36.001;
    s.watch.callback!();
    expect(onBarH).toHaveBeenLastCalledWith(36);
    s.view.unmount();
  });
});
