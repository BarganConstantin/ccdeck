// The line every LAN sync round waits in, driven on its own.
//
// lan-engine.test.ts drives the same rules end to end — two engines, a real
// socket, a press landing on the timer's round (#1040, #1132) — and those stay
// the proof that the engine uses the line. What is pinned here is the line
// itself, with jobs that are plain promises somebody resolves by hand, so each
// rule is one case rather than one choreography of sockets.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createTurns } from "../../server/lan-turns.mjs";

type Turns = {
  inTurn: <T>(job: () => T | Promise<T>) => Promise<T>;
  round: <T>(session: number, job: () => T | Promise<T>) => Promise<T>;
  ahead: () => Promise<void>;
};

/** A job that runs when the line reaches it and finishes when told to. */
function gate<T>(value: T) {
  let open!: () => void;
  const opened = new Promise<void>(r => { open = r; });
  const log: string[] = [];
  const job = async () => { log.push("started"); await opened; log.push("finished"); return value; };
  return { job, open, log };
}

/** Let every promise that can settle, settle. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe("a whole round", () => {
  it("asked for while one runs in the same session is that round (#1040)", async () => {
    const turns: Turns = createTurns();
    const first = gate(["healed"]);
    let calls = 0;
    const job = () => { calls++; return first.job(); };
    const a = turns.round(1, job);
    const b = turns.round(1, job);
    expect(b).toBe(a);
    first.open();
    expect(await a).toEqual(["healed"]);
    expect(calls).toBe(1);
  });

  it("asked for after the last one settled is a new round", async () => {
    const turns: Turns = createTurns();
    let calls = 0;
    const job = async () => ++calls;
    expect(await turns.round(1, job)).toBe(1);
    expect(await turns.round(1, job)).toBe(2);
  });

  it("from a new session queues behind a round from one that ended, never joins it", async () => {
    const turns: Turns = createTurns();
    const old = gate("old");
    const a = turns.round(1, old.job);
    const fresh = gate("fresh");
    const b = turns.round(2, fresh.job);
    expect(b).not.toBe(a);
    await settle();
    // Behind it, not beside it.
    expect(old.log).toEqual(["started"]);
    expect(fresh.log).toEqual([]);
    old.open();
    await a;
    await settle();
    expect(fresh.log).toEqual(["started"]);
    fresh.open();
    expect(await b).toBe("fresh");
  });
});

describe("a check of one deck", () => {
  it("waits behind a round that is running rather than dialling beside it (#1132)", async () => {
    const turns: Turns = createTurns();
    const whole = gate("round");
    const running = turns.round(1, whole.job);
    const one = gate("check");
    const check = turns.inTurn(one.job);
    await settle();
    expect(one.log).toEqual([]);
    whole.open();
    await running;
    await settle();
    expect(one.log).toEqual(["started"]);
    one.open();
    expect(await check).toBe("check");
  });

  it("is never joined by a round, which waits for it instead", async () => {
    const turns: Turns = createTurns();
    const one = gate("check");
    const check = turns.inTurn(one.job);
    const whole = gate("round");
    const round = turns.round(1, whole.job);
    expect(round).not.toBe(check);
    await settle();
    expect(whole.log).toEqual([]);
    one.open();
    await check;
    await settle();
    expect(whole.log).toEqual(["started"]);
    whole.open();
    expect(await round).toBe("round");
  });

  it("can wait for everything ahead of it without joining the line", async () => {
    const turns: Turns = createTurns();
    const whole = gate("round");
    void turns.round(1, whole.job);
    let behind = false;
    const waited = turns.ahead().then(() => { behind = true; });
    await settle();
    expect(behind).toBe(false);
    whole.open();
    await waited;
    expect(whole.log).toEqual(["started", "finished"]);
  });
});

describe("a turn that throws", () => {
  it("is heard by its own caller and stops nothing behind it", async () => {
    const turns: Turns = createTurns();
    const broken = turns.inTurn(async () => { throw new Error("store locked"); });
    const next = turns.inTurn(async () => "next");
    await expect(broken).rejects.toThrow("store locked");
    expect(await next).toBe("next");
    // And the line itself never rejects, so whatever waits on it is not
    // handed somebody else's failure.
    await expect(turns.ahead()).resolves.toBeUndefined();
  });

  it("does not leave a failed round standing as the one to join", async () => {
    const turns: Turns = createTurns();
    let calls = 0;
    const job = async () => { calls++; if (calls === 1) throw new Error("no"); return "ok"; };
    await expect(turns.round(1, job)).rejects.toThrow("no");
    expect(await turns.round(1, job)).toBe("ok");
  });
});
