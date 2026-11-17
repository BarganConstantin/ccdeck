import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async () => (await import("./fake-react")).react);
import { mount } from "./fake-react";
import { useFmScene } from "../use-fm-scene";
import { useBarLedge } from "../fm-ledge";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the character's measured ledge", () => {
  it("keeps a full-length stroll within the smaller minimap", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0);
    const scene = {
      getBoundingClientRect: () => ({ width: 142, right: 985, bottom: 985 }),
      parentElement: { getBoundingClientRect: () => ({ width: 1000, right: 1000 }) },
      querySelector: (selector: string) => selector === ".fm-sprite" ? { offsetWidth: 54 }
        : selector === ".fm-walker" ? { getBoundingClientRect: () => ({ bottom: 878 }) } : null,
    };
    const probe = { live: true, channel: "test" };
    let state: ReturnType<typeof useFmScene>;
    const mounted = mount(() => {
      state = useFmScene(probe, false, false);
      state.scene.current = scene as unknown as HTMLDivElement;
      return null;
    }, {});
    try {
      vi.advanceTimersByTime(6000);
      expect(state!.act).toBe("walk");
      expect(state!.x).toBeGreaterThanOrEqual(-(142 - 54));
      expect(state!.x).toBeLessThanOrEqual(0);
    } finally { mounted.unmount(); }
  });
});

// Round 3, point 6: the ledge is the control bar's left end, measured from the
// bar itself, and the floor walk below it stops short of a minimap standing in
// the left corner.
describe("the bar the character stands on", () => {
  function measure(bar: { left: number; width: number } | null) {
    const host = {
      getBoundingClientRect: () => ({ right: 1400 }),
      querySelector: (sel: string) => (sel === ".react-flow__controls" && bar ? { getBoundingClientRect: () => bar } : null),
    };
    const scene = { current: { parentElement: host } as unknown as HTMLElement };
    let ledge: ReturnType<typeof useBarLedge> = null;
    const m = mount(() => { ledge = useBarLedge(scene, true); return null; }, {});
    m.unmount();
    return ledge;
  }

  it("is the bar's left end, measured", () => {
    expect(measure({ left: 1400 - 12 - 252, width: 252 })).toEqual({ right: 162, width: 102 });
  });

  it("is no ledge without a bar, or with only the Command Panel's button", () => {
    expect(measure(null)).toBeNull();
    expect(measure({ left: 1400 - 12 - 30, width: 30 })).toBeNull();
  });
});

describe("the trip off the bar", () => {
  /** Where the first floor walk ends, on a 1400px canvas whose bar ledge
   *  ends at 1238 and stands 25px over the floor, with or without a minimap
   *  in the left corner (right edge 154, foot 7px under the head's height). */
  function farthest(withMap: boolean): number {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null });
    vi.stubGlobal("window", { innerWidth: 1400, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    // The idle beat, then "leave" (its band of ACTIVITIES), then both wanders to the far end.
    vi.spyOn(Math, "random").mockReturnValueOnce(0.8).mockReturnValueOnce(109.5 / 135).mockReturnValue(1);
    const map = { getBoundingClientRect: () => ({ right: 154, bottom: 850 }) };
    const scene = {
      getBoundingClientRect: () => ({ width: 102, right: 1238, bottom: 885 }),
      parentElement: {
        getBoundingClientRect: () => ({ width: 1400, right: 1400 }),
        querySelector: (sel: string) => (withMap && sel === ".react-flow__minimap" ? map : null),
      },
      querySelector: (selector: string) => selector === ".fm-sprite" ? { offsetWidth: 54, offsetHeight: 42 }
        : selector === ".fm-walker" ? { getBoundingClientRect: () => ({ bottom: 860 }) } : null,
    };
    const probe = { live: true, channel: "test" };
    let state: ReturnType<typeof useFmScene>;
    const mounted = mount(() => {
      state = useFmScene(probe, false, false);
      state.scene.current = scene as unknown as HTMLDivElement;
      return null;
    }, {});
    try {
      // 14s of rest, then the walk to the far end, the look, the drop and the landing.
      vi.advanceTimersByTime(14_000 + 2208 + 620 + 183 + 200 + 50);
      expect(state!.place).toBe("floor");
      return state!.x;
    } finally { mounted.unmount(); }
  }

  it("walks the floor to the canvas's edge", () => {
    expect(farthest(false)).toBe(-(1238 - 12 - 54));
  });

  it("stops short of a minimap in the left corner", () => {
    expect(farthest(true)).toBe(-(1238 - (154 + 12) - 54));
  });
});
