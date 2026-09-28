// When the next sync round runs, driven on its own: a round the test counts
// (and can make throw or hold open), a "still deciding" the test answers, and
// the fake clock.
//
// lan-engine.test.ts pins why there are two gaps and that the sentence the
// clock watches for is the one lan-socket.mjs sends. What is pinned here is
// the loop: the first round a whole minute after a start, the gap picked after
// each round finishes, a round that throws not ending it, and nothing more
// scheduled once the start that began it is over.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { ASKING_MS, createRoundTimer, SYNC_MS } from "../../server/lan-round-timer.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { ASKING_MS as ENGINE_ASKING_MS, SYNC_MS as ENGINE_SYNC_MS } from "../../server/lan-engine.mjs";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function rig() {
  const st = { rounds: 0, waiting: false, ended: false, fail: false, hold: null as null | Promise<void> };
  const round = async () => {
    st.rounds++;
    if (st.hold) await st.hold;
    if (st.fail) throw new Error("a round that throws");
  };
  const timer = createRoundTimer({ round, waiting: () => st.waiting });
  return { timer, st, start: () => timer.start(() => st.ended) };
}

describe("the loop", () => {
  it("runs the first round a whole minute after it starts", async () => {
    const r = rig();
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS - 1);
    expect(r.st.rounds).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.st.rounds).toBe(1);
  });

  it("waits a minute between rounds at rest, and seconds while somebody is deciding", async () => {
    const r = rig();
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    expect(r.st.rounds).toBe(1);
    await vi.advanceTimersByTimeAsync(ASKING_MS);
    expect(r.st.rounds).toBe(1);
    await vi.advanceTimersByTimeAsync(SYNC_MS - ASKING_MS);
    expect(r.st.rounds).toBe(2);
    // Asked after a round finishes, so the round that raised the request is
    // the one that tightens the gap after it.
    r.st.waiting = true;
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    expect(r.st.rounds).toBe(3);
    await vi.advanceTimersByTimeAsync(ASKING_MS);
    expect(r.st.rounds).toBe(4);
    // Answered — either way — and it relaxes again.
    r.st.waiting = false;
    await vi.advanceTimersByTimeAsync(ASKING_MS);
    expect(r.st.rounds).toBe(5);
    await vi.advanceTimersByTimeAsync(ASKING_MS);
    expect(r.st.rounds).toBe(5);
    await vi.advanceTimersByTimeAsync(SYNC_MS - ASKING_MS);
    expect(r.st.rounds).toBe(6);
  });

  it("measures each gap from the end of a round, however long it ran", async () => {
    const r = rig();
    let release = () => {};
    r.st.hold = new Promise<void>(res => { release = res; });
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    expect(r.st.rounds).toBe(1);
    // Still running three minutes later: nothing else is started beside it.
    await vi.advanceTimersByTimeAsync(3 * SYNC_MS);
    expect(r.st.rounds).toBe(1);
    r.st.hold = null;
    release();
    await vi.advanceTimersByTimeAsync(SYNC_MS - 1);
    expect(r.st.rounds).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.st.rounds).toBe(2);
  });

  it("keeps going after a round that throws", async () => {
    const r = rig();
    r.st.fail = true;
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS * 3);
    expect(r.st.rounds).toBe(3);
  });
});

describe("ending it", () => {
  it("schedules nothing after the round running when its start ended", async () => {
    const r = rig();
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    r.st.ended = true;
    await vi.advanceTimersByTimeAsync(SYNC_MS * 5);
    expect(r.st.rounds).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls off the round scheduled next", async () => {
    const r = rig();
    r.start();
    r.timer.stop();
    await vi.advanceTimersByTimeAsync(SYNC_MS * 5);
    expect(r.st.rounds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // And stopping what is not running is nothing.
    expect(() => r.timer.stop()).not.toThrow();
  });

  it("is started again from nothing, one loop at a time", async () => {
    const r = rig();
    r.start();
    r.timer.stop();
    r.start();
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    expect(r.st.rounds).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("the two gaps", () => {
  it("are the numbers the engine still exports", () => {
    expect(ENGINE_SYNC_MS).toBe(SYNC_MS);
    expect(ENGINE_ASKING_MS).toBe(ASKING_MS);
  });
});
