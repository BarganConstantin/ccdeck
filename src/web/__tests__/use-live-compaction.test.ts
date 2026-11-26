// A compaction read off the live screen while the session's turn is over
// (use-live-compaction.ts): only while on, from the session's own subject,
// every STATUS_POLL_MS; held through a frame without its line, gone once the
// line has been missing for COMPACTION_MISSES reads, and started afresh for
// another session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_MISSES, MENU_MISSES } from "../live-activity";
import { STATUS_POLL_MS } from "../use-screen-status";
import { useLiveCompaction, useLiveScreen, type LiveCompactionOptions, type LiveScreen } from "../use-live-compaction";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const NOW = 2_000_000;
const COMPACTING = "⏺ Compacting…\n\n✳ Compacting conversation… (esc to interrupt · 37s · ↓ 1.2k tokens)\n\n> ";
const IDLE = "⏺ Compacted (ctrl+o to see full summary)\n\n> ";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

function rig(first: Omit<LiveCompactionOptions, "readScreen">, screen: string | null = COMPACTING) {
  let shown = screen;
  const readScreen = vi.fn((_subject: string) => shown);
  let seen: { since: number } | null = null;
  const Probe = (o: Omit<LiveCompactionOptions, "readScreen">) => { seen = useLiveCompaction({ ...o, readScreen }); return null; };
  const view = mount(Probe, first);
  return { view, readScreen, set screen(s: string | null) { shown = s; }, get seen() { return seen; } };
}

describe("a compaction, live", () => {
  it("reads nothing while off", async () => {
    const r = rig({ on: false, subject: "session:a" });
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    expect(r.readScreen).not.toHaveBeenCalled();
    expect(r.seen).toBeNull();
  });

  it("reads the session's own screen at once and counts from the spinner's clock", () => {
    const r = rig({ on: true, subject: "session:a" });
    expect(r.readScreen).toHaveBeenCalledWith("session:a");
    expect(r.seen?.since).toBe(NOW - 37_000);
  });

  it("holds through a frame without its line, and ends once it has been gone for COMPACTION_MISSES reads", async () => {
    const r = rig({ on: true, subject: "session:a" });
    r.screen = IDLE;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * (COMPACTION_MISSES - 1));
    expect(r.seen?.since).toBe(NOW - 37_000);
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.seen).toBeNull();
  });

  it("ends as soon as the spinner says something else, and a pane that cannot be read counts as a miss", async () => {
    const r = rig({ on: true, subject: "session:a" });
    r.screen = "✻ Pondering… (2s · esc to interrupt)";
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.seen).toBeNull();
    r.screen = COMPACTING;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.seen).not.toBeNull();
    r.screen = null;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * COMPACTION_MISSES);
    expect(r.seen).toBeNull();
  });

  it("is nothing on a screen that shows none, goes when switched off, and starts afresh for another session", async () => {
    expect(rig({ on: true, subject: "session:a" }, IDLE).seen).toBeNull();
    const r = rig({ on: true, subject: "session:a" });
    r.view.rerender({ on: false, subject: "session:a" });
    expect(r.seen).toBeNull();
    const calls = r.readScreen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    expect(r.readScreen).toHaveBeenCalledTimes(calls);
    r.screen = IDLE;
    r.view.rerender({ on: true, subject: "session:b" });
    expect(r.readScreen).toHaveBeenLastCalledWith("session:b");
    expect(r.seen).toBeNull();
  });
});

// The same read finds a menu the agent draws itself, for Chat's line that
// says it waits in Term (screen-status.ts screenMenu).
const MENU = "⏺ Wrote reviewer.md\n\n Save this agent?\n ❯ 1. Looks good — save it\n   2. Discard and exit\n\n Enter to confirm · Esc to cancel";

function screenRig(first: Omit<LiveCompactionOptions, "readScreen">, screen: string | null = MENU) {
  let shown = screen;
  const readScreen = vi.fn((_subject: string) => shown);
  let seen: LiveScreen | null = null;
  const Probe = (o: Omit<LiveCompactionOptions, "readScreen">) => { seen = useLiveScreen({ ...o, readScreen }); return null; };
  const view = mount(Probe, first);
  return { view, readScreen, set screen(s: string | null) { shown = s; }, get seen() { return seen!; } };
}

describe("a menu, live", () => {
  it("is read off the session's own screen at once, with its choices", () => {
    const r = screenRig({ on: true, subject: "session:a" });
    expect(r.readScreen).toHaveBeenCalledWith("session:a");
    expect(r.seen.menu).toEqual(["Looks good — save it", "Discard and exit"]);
    expect(r.seen.compacting).toBeNull();
  });

  it("holds through a frame without it, and clears once it has been gone for MENU_MISSES reads", async () => {
    const r = screenRig({ on: true, subject: "session:a" });
    r.screen = IDLE;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * (MENU_MISSES - 1));
    expect(r.seen.menu).not.toBeNull();
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    expect(r.seen.menu).toBeNull();
  });

  it("is nothing while off, and another session's screen starts from nothing", async () => {
    const off = screenRig({ on: false, subject: "session:a" });
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2);
    expect(off.readScreen).not.toHaveBeenCalled();
    expect(off.seen.menu).toBeNull();
    const r = screenRig({ on: true, subject: "session:a" });
    r.screen = IDLE;
    r.view.rerender({ on: true, subject: "session:b" });
    expect(r.readScreen).toHaveBeenLastCalledWith("session:b");
    // Session a's menu is not carried over to b, not even for its misses.
    expect(r.seen.menu).toBeNull();
  });
});
