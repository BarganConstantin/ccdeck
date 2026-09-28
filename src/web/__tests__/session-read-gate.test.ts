// The gate in front of every enrichment read, driven directly.
//
// Six passes used to carry their own copy of this rule — the model, usage,
// name and context passes, the Codex memory scan and the Codex usage read —
// and each copy was only ever exercised through a live server, a transcript
// on disk and a 2.5-second wait. The rule is small enough to state as a table
// of calls and a clock, so that is how it is held here: what a second event
// inside the window does, what a read still in flight does, what a failed
// read leaves behind, and what `forget` and `forgetAll` release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionReadGate } from "../../server/session-read-gate.mjs";

const WINDOW = 2500;

/** A read the test settles by hand, and how many times the gate started one. */
function reads() {
  const settle: Array<(ok: boolean) => void> = [];
  let started = 0;
  const read = () => {
    started++;
    return new Promise<void>((resolve, reject) => {
      settle.push(ok => (ok ? resolve() : reject(new Error("unreadable"))));
    });
  };
  return { read, started: () => started, settle: (ok = true) => settle.shift()!(ok) };
}

/** Let the gate's `.catch().finally()` run after a read settles. */
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_790_550_000_000);
});
afterEach(() => { vi.useRealTimers(); });

describe("sessionReadGate", () => {
  it("reads once per window, and again once the window has passed", async () => {
    const gate = sessionReadGate(WINDOW);
    const r = reads();
    gate.run("s1", r.read);
    expect(r.started()).toBe(1);
    r.settle();
    await flush();

    vi.advanceTimersByTime(WINDOW - 1);
    gate.run("s1", r.read);
    expect(r.started(), "a second event inside the window").toBe(1);

    vi.advanceTimersByTime(1);
    gate.run("s1", r.read);
    expect(r.started(), "the first event at the window's edge").toBe(2);
  });

  it("calls the read before run returns", () => {
    const gate = sessionReadGate(WINDOW);
    const order: string[] = [];
    gate.run("s1", () => { order.push("read"); return Promise.resolve(); });
    order.push("after run");
    expect(order).toEqual(["read", "after run"]);
  });

  it("holds a session back while its read is in flight, however long that takes", async () => {
    const gate = sessionReadGate(WINDOW);
    const r = reads();
    gate.run("s1", r.read);
    vi.advanceTimersByTime(WINDOW * 10);
    gate.run("s1", r.read);
    expect(r.started(), "a read still running is never doubled").toBe(1);

    r.settle();
    await flush();
    gate.run("s1", r.read);
    expect(r.started(), "let through once it settles").toBe(2);
  });

  it("stamps the read as it starts, so a failed one still throttles, and swallows the failure", async () => {
    const gate = sessionReadGate(WINDOW);
    const r = reads();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      gate.run("s1", r.read);
      r.settle(false);
      await flush();
      gate.run("s1", r.read);
      expect(r.started(), "a failure does not reopen the window").toBe(1);
      vi.advanceTimersByTime(WINDOW);
      gate.run("s1", r.read);
      expect(r.started()).toBe(2);
      r.settle();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps each session to its own window and its own read", () => {
    const gate = sessionReadGate(WINDOW);
    const a = reads(), b = reads();
    gate.run("a", a.read);
    gate.run("b", b.read);
    gate.run("a", a.read);
    expect([a.started(), b.started()]).toEqual([1, 1]);
  });

  it("keeps two gates apart, so one pass never throttles another", () => {
    const model = sessionReadGate(WINDOW), usage = sessionReadGate(WINDOW);
    const r = reads();
    model.run("s1", r.read);
    usage.run("s1", r.read);
    expect(r.started()).toBe(2);
  });

  it("reads at once after forget, for that session only", async () => {
    const gate = sessionReadGate(WINDOW);
    const a = reads(), b = reads();
    gate.run("a", a.read);
    gate.run("b", b.read);
    a.settle(); b.settle();
    await flush();

    gate.forget("a");
    gate.run("a", a.read);
    gate.run("b", b.read);
    expect([a.started(), b.started()]).toEqual([2, 1]);
  });

  it("reads at once after forgetAll, for every session", async () => {
    const gate = sessionReadGate(WINDOW);
    const a = reads(), b = reads();
    gate.run("a", a.read);
    gate.run("b", b.read);
    a.settle(); b.settle();
    await flush();

    gate.forgetAll();
    gate.run("a", a.read);
    gate.run("b", b.read);
    expect([a.started(), b.started()]).toEqual([2, 2]);
  });

  it("never lets forget or forgetAll double a read that is still in flight", async () => {
    const gate = sessionReadGate(WINDOW);
    const r = reads();
    gate.run("s1", r.read);
    gate.forget("s1");
    gate.run("s1", r.read);
    gate.forgetAll();
    gate.run("s1", r.read);
    expect(r.started()).toBe(1);
    r.settle();
    await flush();
    gate.run("s1", r.read);
    expect(r.started(), "the forgotten stamp lets the next event through at once").toBe(2);
  });
});
