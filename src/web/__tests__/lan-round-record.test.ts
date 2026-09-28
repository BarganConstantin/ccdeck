// What a deck's last round did, driven on its own: records the test writes
// and a clock the test moves.
//
// lan-engine.test.ts proves the same record through whole engines — a round's
// line on each row, a dial-back given up on, a `check now` that joins the
// round already asking. What is pinned here is the bookkeeping underneath:
// one record per row, the latest only, kept as it was handed over; when the
// whole round last finished; and which record means somebody is still
// deciding.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createRoundRecord } from "../../server/lan-round-record.mjs";

const T0 = 1_790_550_000_000;
/** The sentence a dialler reads the far deck's refusal as while nobody there
 *  has accepted this deck yet — see REFUSALS in lan-call.mjs. */
const NOT_YET = "waiting for the other deck to accept this one";

function rig() {
  const st = { t: T0 };
  return { rec: createRoundRecord({ now: () => st.t }), st };
}

describe("a row's record", () => {
  it("is the latest ask of it, the very record handed over", () => {
    const { rec } = rig();
    expect(rec.of("fp-a")).toBeUndefined();
    const first = { at: T0, name: "A", offered: 2, done: [] };
    rec.keep("fp-a", first);
    expect(rec.of("fp-a")).toBe(first);
    // The same object until something asks that row again — which is how a
    // `check now` tells an ask that happened while it waited from none.
    const second = { at: T0 + 1, name: "A", error: "peer went quiet", done: [] };
    rec.keep("fp-a", second);
    expect(rec.of("fp-a")).toBe(second);
    expect(rec.of("fp-a")).not.toBe(first);
  });

  it("is kept per row, and dropped for one alone", () => {
    const { rec } = rig();
    rec.keep("fp-a", { done: [] });
    rec.keep("manual:10.0.0.5:4800", { done: [] });
    rec.drop("manual:10.0.0.5:4800");
    expect(rec.of("manual:10.0.0.5:4800")).toBeUndefined();
    expect(rec.of("fp-a")).toEqual({ done: [] });
    expect(() => rec.drop("never-asked")).not.toThrow();
  });
});

describe("when the round last finished", () => {
  it("is nothing until one has, then the engine's clock at the end of it", () => {
    const { rec, st } = rig();
    expect(rec.checkedAt()).toBeNull();
    st.t = T0 + 60_000;
    rec.finished();
    st.t = T0 + 90_000;
    expect(rec.checkedAt()).toBe(T0 + 60_000);
  });

  it("is not moved by a row's own record", () => {
    const { rec } = rig();
    rec.finished();
    rec.keep("fp-a", { at: T0 + 5, done: [] });
    expect(rec.checkedAt()).toBe(T0);
  });
});

describe("somebody still deciding", () => {
  it("is a row whose last ask was refused as not accepted yet", () => {
    const { rec } = rig();
    expect(rec.waitingOnSomebody()).toBe(false);
    rec.keep("fp-a", { error: "peer went quiet", done: [] });
    rec.keep("fp-b", { offered: 3, done: [] });
    expect(rec.waitingOnSomebody()).toBe(false);
    rec.keep("fp-c", { error: NOT_YET, done: [] });
    expect(rec.waitingOnSomebody()).toBe(true);
  });

  it("stops the moment that row is answered, either way, or dropped", () => {
    const { rec } = rig();
    rec.keep("fp-a", { error: NOT_YET, done: [] });
    // A refusal is an answer.
    rec.keep("fp-a", { error: "that deck said no", done: [] });
    expect(rec.waitingOnSomebody()).toBe(false);
    rec.keep("fp-b", { error: NOT_YET, done: [] });
    rec.drop("fp-b");
    expect(rec.waitingOnSomebody()).toBe(false);
  });
});
