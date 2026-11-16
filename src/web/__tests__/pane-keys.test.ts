import { afterEach, describe, expect, it } from "vitest";
import { paneHoldsKeys, resetPaneKeys, type PaneKeysDeps } from "../pane-keys";

function fakeDeps() {
  const said: boolean[] = [];
  const quiet: boolean[] = [];
  let ticks = 0;
  let running = 0;
  const deps: PaneKeysDeps = {
    tell: owned => { said.push(owned); },
    quiet: on => { quiet.push(on); },
    every: () => { running++; ticks++; return () => { running--; }; },
  };
  return { deps, said, quiet, running: () => running, started: () => ticks };
}

describe("the keys across panes (internal #102)", () => {
  afterEach(() => resetPaneKeys());

  it("one pane says what it holds, as the one stage did", () => {
    const f = fakeDeps();
    const a = {};
    paneHoldsKeys(a, false, f.deps);
    paneHoldsKeys(a, true, f.deps);
    paneHoldsKeys(a, false, f.deps);
    expect(f.said).toEqual([false, true, false]);
    expect(f.quiet).toEqual([true, false]);
    expect(f.running()).toBe(0);
  });

  it("the pane the keys left, heard last, does not give the desktop its shortcuts back", () => {
    const f = fakeDeps();
    const a = {}, b = {};
    paneHoldsKeys(a, true, f.deps);
    paneHoldsKeys(b, true, f.deps);
    paneHoldsKeys(a, false, f.deps);
    expect(f.said.at(-1)).toBe(true);
    expect(f.quiet).toEqual([true]);
    expect(f.started()).toBe(1);
    expect(f.running()).toBe(1);
    paneHoldsKeys(b, false, f.deps);
    expect(f.said.at(-1)).toBe(false);
    expect(f.quiet).toEqual([true, false]);
    expect(f.running()).toBe(0);
  });

  it("a pane that goes while another types leaves the page quiet", () => {
    const f = fakeDeps();
    const a = {}, b = {};
    paneHoldsKeys(b, true, f.deps);
    paneHoldsKeys(a, false, f.deps);
    expect(f.said).toEqual([true, true]);
    expect(f.quiet).toEqual([true]);
  });
});
