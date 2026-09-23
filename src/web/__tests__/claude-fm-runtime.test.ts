import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneTimer } from "../claude-fm-runtime";

class Visibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("character scene timer", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("runs a visible scene once after its delay", () => {
    const visibility = new Visibility();
    const timer = createSceneTimer(visibility);
    const run = vi.fn();
    timer.schedule(run, 1000);
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    timer.dispose();
  });

  it("uses no timer while hidden and resumes the remaining duration", () => {
    const visibility = new Visibility();
    const timer = createSceneTimer(visibility);
    const run = vi.fn();
    timer.schedule(run, 1000);
    vi.advanceTimersByTime(300);
    visibility.setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    visibility.setHidden(false);
    vi.advanceTimersByTime(699);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    timer.dispose();
  });

  it("does not start a scene mounted in a hidden tab", () => {
    const visibility = new Visibility();
    visibility.hidden = true;
    const timer = createSceneTimer(visibility);
    const run = vi.fn();
    timer.schedule(run, 500);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    visibility.setHidden(false);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
    timer.dispose();
  });

  it("tolerates repeated hide/show events without duplicate callbacks", () => {
    const visibility = new Visibility();
    const timer = createSceneTimer(visibility);
    const run = vi.fn();
    timer.schedule(run, 1000);
    vi.advanceTimersByTime(200);
    visibility.setHidden(true);
    visibility.setHidden(true);
    visibility.setHidden(false);
    visibility.setHidden(false);
    vi.advanceTimersByTime(200);
    visibility.setHidden(true);
    vi.advanceTimersByTime(5000);
    visibility.setHidden(false);
    vi.advanceTimersByTime(599);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    timer.dispose();
  });

  it("replaces a pending step and can schedule the next from its callback", () => {
    const visibility = new Visibility();
    const timer = createSceneTimer(visibility);
    const old = vi.fn(), next = vi.fn();
    timer.schedule(old, 1000);
    timer.schedule(() => timer.schedule(next, 200), 100);
    vi.advanceTimersByTime(300);
    expect(old).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    timer.dispose();
  });

  it("disposes pending work and its visibility listener", () => {
    const visibility = new Visibility();
    const remove = vi.spyOn(visibility, "removeEventListener");
    const timer = createSceneTimer(visibility);
    const run = vi.fn();
    timer.schedule(run, 1000);
    visibility.setHidden(true);
    timer.dispose();
    visibility.setHidden(false);
    timer.schedule(run, 0);
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
