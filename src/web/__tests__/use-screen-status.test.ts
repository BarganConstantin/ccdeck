// The working row's words read off the live screen (use-screen-status.ts):
// only while on, from the session's own subject, every STATUS_POLL_MS, kept
// between two frames that show none, gone with the turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_POLL_MS, useScreenStatus, type ScreenStatusOptions } from "../use-screen-status";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function rig(first: Omit<ScreenStatusOptions, "readScreen">) {
  let shown: string | null = "✻ Pondering… (1s · esc to interrupt)";
  const readScreen = vi.fn((_subject: string) => shown);
  let words: string | null = null;
  const renders: Array<{ subject: string; words: string | null }> = [];
  const Probe = (o: Omit<ScreenStatusOptions, "readScreen">) => {
    words = useScreenStatus({ ...o, readScreen });
    renders.push({ subject: o.subject, words });
    return null;
  };
  const view = mount(Probe, first);
  return { view, readScreen, renders, set screen(s: string | null) { shown = s; }, get words() { return words; } };
}

describe("the agent's words, live", () => {
  it("reads nothing while off", async () => {
    const r = rig({ on: false, subject: "session:a" });
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    expect(r.readScreen).not.toHaveBeenCalled();
    expect(r.words).toBeNull();
  });

  it("reads the session's own screen at once, then every second, and follows the words", async () => {
    const r = rig({ on: true, subject: "session:a" });
    expect(r.readScreen).toHaveBeenCalledWith("session:a");
    expect(r.words).toBe("Pondering…");
    r.screen = "✶ Brewing… (4s · esc to interrupt)";
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS - 1);
    expect(r.words).toBe("Pondering…");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.words).toBe("Brewing…");
    expect(r.readScreen).toHaveBeenCalledTimes(2);
  });

  it("keeps its words through a frame that shows none, or no screen at all", async () => {
    const r = rig({ on: true, subject: "session:a" });
    r.screen = "⏺ Reading routes.ts";
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.words).toBe("Pondering…");
    r.screen = null;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.words).toBe("Pondering…");
  });

  it("never renders the previous session's spinner during a direct switch", () => {
    const r = rig({ on: true, subject: "session:a" });
    r.screen = null;
    r.view.rerender({ on: true, subject: "session:b" });
    expect(r.renders.filter(render => render.subject === "session:b").map(render => render.words)).not.toContain("Pondering…");
  });

  it("lets them go with the turn, and starts afresh for another session", async () => {
    const r = rig({ on: true, subject: "session:a" });
    r.view.rerender({ on: false, subject: "session:a" });
    expect(r.words).toBeNull();
    const calls = r.readScreen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    expect(r.readScreen).toHaveBeenCalledTimes(calls);
    r.screen = null;
    r.view.rerender({ on: true, subject: "session:b" });
    expect(r.readScreen).toHaveBeenLastCalledWith("session:b");
    expect(r.words).toBeNull();
  });
});
