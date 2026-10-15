import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async () => (await import("./fake-react")).react);
import { mount } from "./fake-react";
import { useFmScene } from "../use-fm-scene";

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
