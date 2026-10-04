// The rating question waits for any open dialog — but "any" meant the dialogs
// App.tsx opens itself. The ones a panel opens — CPU and load history, Busiest
// processes, the network map, a sign-in, a pairing request, the re-sign-in
// prompt — are on the dialog stack and nowhere else, so a look that came round
// while one of them was open put the question in the strip behind its scrim,
// where nothing in it could be pressed.
//
// Run, not read: the hook is called on fake-react.ts's React, against the real
// stack every dialog registers itself on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useRatingAsk } = await import("../use-rating-ask");
const { modalStack } = await import("../modal-dismiss");

const FIRST_LOOK = 5 * 60 * 1000;
const NEXT_LOOK = 30 * 60 * 1000;

let reads = 0;
const opened: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("fetch", async () => { reads++; return { ok: true, json: async () => ({ ok: true, ask: true }) }; });
});
afterEach(() => {
  while (opened.length) opened.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The question's hook, with no App-level dialog open. */
function deck() {
  const view = mount(useRatingAsk, { modalOpenRef: { current: false } });
  return () => (view.tree as ReturnType<typeof useRatingAsk>).ratingPhase;
}
const wait = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

describe("the rating question and a dialog a panel opened", () => {
  it("does not turn up behind it", async () => {
    const phase = deck();
    // The CPU history chart, say: a dialog on the stack, not one of App's.
    opened.push(modalStack.push(() => {}));
    await wait(FIRST_LOOK);
    expect(phase()).toBe("hidden");
    expect(reads).toBe(0);
  });

  it("is asked at the next look once it has closed", async () => {
    const phase = deck();
    opened.push(modalStack.push(() => {}));
    await wait(FIRST_LOOK);
    opened.pop()!();
    await wait(NEXT_LOOK);
    expect(phase()).toBe("asking");
  });

  it("but a popover is not a dialog, and does not hold it back", async () => {
    const phase = deck();
    opened.push(modalStack.push(() => {}, undefined, "popover"));
    await wait(FIRST_LOOK);
    expect(phase()).toBe("asking");
  });
});
