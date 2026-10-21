import { describe, expect, it, vi } from "vitest";
import { createThemeTransition } from "../theme-transition";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const requests: Array<{
    update: () => void;
    ready: ReturnType<typeof deferred>;
    updated: ReturnType<typeof deferred>;
    finished: ReturnType<typeof deferred>;
    skip: ReturnType<typeof vi.fn>;
  }> = [];
  const doc = {
    hidden: false,
    documentElement: { dataset: {} as { themeTransition?: string } },
    startViewTransition: vi.fn((update: () => void) => {
      const ready = deferred(), updated = deferred(), finished = deferred(), skip = vi.fn();
      requests.push({ update, ready, updated, finished, skip });
      return { ready: ready.promise, updateCallbackDone: updated.promise, finished: finished.promise, skipTransition: skip };
    }),
  };
  const reduced = vi.fn(() => false);
  return { doc, requests, reduced, motion: createThemeTransition(doc, reduced) };
}

describe("theme snapshot coordination", () => {
  it("updates only after the old view is captured, then clears its scope on completion", async () => {
    const { doc, requests, motion } = harness();
    const update = vi.fn();
    motion.run(update);
    expect(update).not.toHaveBeenCalled();
    expect(doc.documentElement.dataset.themeTransition).toBe("true");
    requests[0].update();
    expect(update).toHaveBeenCalledOnce();
    requests[0].finished.resolve();
    await Promise.resolve();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
  it("applies the latest request when skipped browser callbacks arrive out of order", () => {
    const { requests, motion } = harness();
    const applied: string[] = [];
    motion.run(() => applied.push("light"));
    motion.run(() => applied.push("dark"));
    motion.run(() => applied.push("gruvbox-material"));
    requests[2].update();
    requests[0].update();
    requests[1].update();
    expect(applied).toEqual(["gruvbox-material"]);
    expect(requests[0].skip).toHaveBeenCalledOnce();
    expect(requests[1].skip).toHaveBeenCalledOnce();
  });
  it("does not let completion of an old fade clear the new fade's scope", async () => {
    const { doc, requests, motion } = harness();
    motion.run(() => {});
    requests[0].update();
    motion.run(() => {});
    requests[0].finished.resolve();
    await Promise.resolve();
    expect(doc.documentElement.dataset.themeTransition).toBe("true");
    requests[1].finished.resolve();
    await Promise.resolve();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
  for (const fallback of ["unsupported", "reduced", "hidden"] as const) {
    it(`changes immediately when ${fallback}`, () => {
      const { doc, reduced } = harness();
      const target = fallback === "unsupported" ? { hidden: false, documentElement: doc.documentElement } : doc;
      if (fallback === "reduced") reduced.mockReturnValue(true);
      if (fallback === "hidden") doc.hidden = true;
      const update = vi.fn();
      createThemeTransition(target, reduced).run(update);
      expect(update).toHaveBeenCalledOnce();
      expect(doc.startViewTransition).not.toHaveBeenCalled();
      expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
    });
  }
  it("honours a newly enabled reduced-motion preference during rapid changes", () => {
    const { reduced, requests, motion, doc } = harness();
    const old = vi.fn(), latest = vi.fn();
    motion.run(old);
    reduced.mockReturnValue(true);
    motion.run(latest);
    requests[0].update();
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
  it("falls back when capture cannot start", () => {
    const { doc, motion } = harness();
    doc.startViewTransition.mockImplementation(() => { throw new Error("capture unavailable"); });
    const update = vi.fn();
    motion.run(update);
    expect(update).toHaveBeenCalledOnce();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
  it("handles a rejected capture and still applies the choice exactly once", async () => {
    const { doc, requests, motion } = harness();
    const update = vi.fn();
    motion.run(update);
    requests[0].ready.reject(new Error("capture skipped"));
    requests[0].updated.reject(new Error("update not scheduled"));
    requests[0].finished.reject(new Error("transition failed"));
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
  it("prevents a deferred update after unmount or cancellation", () => {
    const { doc, requests, motion } = harness();
    const update = vi.fn();
    motion.run(update);
    motion.cancel();
    requests[0].update();
    expect(update).not.toHaveBeenCalled();
    expect(requests[0].skip).toHaveBeenCalledOnce();
    expect(doc.documentElement.dataset.themeTransition).toBeUndefined();
  });
});
