// Room on the stage for a pane in the user's own tmux, which keeps the size of
// the user's terminal (case B): made where the window has it, for as long as
// that session is on stage, and given back after (use-pane-room.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { mount } from "./fake-react";
import { roomFor, usePaneRoom } from "../components/terminal/use-pane-room";

const geometry = (cols: number, max = 134, takeover = false) => ({ cols, range: { min: 80, max, default: 100 }, takeover });

describe("how much room a pane needs", () => {
  it("is the pane's width where it is wider than the stage and the window has the room", () => {
    expect(roomFor(120, geometry(93), false)).toBe(120);
    expect(roomFor(90, geometry(93), false), "it fits already").toBeNull();
    expect(roomFor(160, geometry(93, 134), false), "no window has that room: it scrolls instead").toBeNull();
    expect(roomFor(120, geometry(93, 134, true), false), "the takeover is as wide as it goes").toBeNull();
    expect(roomFor(120, geometry(93), true), "so is ⤢").toBeNull();
    expect(roomFor(0, geometry(93), false), "a pane the stage sizes").toBeNull();
  });
});

describe("making room while the session is on stage", () => {
  function stage(start: { key: string; paneCols: number; cols: number }) {
    let shown = { ...start };
    // The divider's setter, as use-stage's is: the stage redraws at the new
    // width once the pass that asked for it is over.
    let moved = false;
    const onCols = vi.fn((cols: number) => { shown = { ...shown, cols }; moved = true; });
    const Probe = (p: typeof shown) => { usePaneRoom(p.key, p.paneCols, geometry(p.cols), false, onCols); return null; };
    const m = mount(Probe, shown);
    const settle = () => { while (moved) { moved = false; m.rerender(shown); } };
    settle();
    return {
      onCols, m,
      get cols() { return shown.cols; },
      show(next: Partial<typeof shown>) { shown = { ...shown, ...next }; m.rerender(shown); settle(); },
    };
  }

  it("widens the stage to the pane, unsettled, and gives the width back when the session goes", () => {
    const s = stage({ key: "session:b", paneCols: 120, cols: 93 });
    expect(s.onCols).toHaveBeenLastCalledWith(120, false);
    expect(s.cols).toBe(120);
    s.show({ key: "session:a", paneCols: 0 });
    expect(s.onCols).toHaveBeenLastCalledWith(93, false);
    expect(s.cols).toBe(93);
  });

  it("follows the user's terminal growing, and still gives back the width it started from", () => {
    const s = stage({ key: "session:b", paneCols: 120, cols: 93 });
    s.show({ paneCols: 128 });
    expect(s.cols).toBe(128);
    s.m.unmount();
    expect(s.onCols).toHaveBeenLastCalledWith(93, false);
  });

  it("leaves the width the reader chose with the divider meanwhile, and never fights it", () => {
    const s = stage({ key: "session:b", paneCols: 120, cols: 93 });
    expect(s.onCols).toHaveBeenCalledTimes(1);
    s.show({ cols: 110 }); // dragged narrower than the pane
    expect(s.cols, "not widened back under the reader's hand").toBe(110);
    s.show({ paneCols: 126 }); // and their terminal grows
    expect(s.cols, "still theirs").toBe(110);
    s.show({ key: "session:a", paneCols: 0 });
    expect(s.onCols, "and nothing given back over their choice").toHaveBeenCalledTimes(1);
    // The next case-B session on stage gets room again.
    s.show({ key: "session:c", paneCols: 124 });
    expect(s.cols).toBe(124);
  });

  it("does nothing for a pane the stage sizes itself", () => {
    const s = stage({ key: "session:a", paneCols: 0, cols: 93 });
    s.show({ key: "session:b" });
    expect(s.onCols).not.toHaveBeenCalled();
  });
});
