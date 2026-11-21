// use-prompt-decision.ts: how long a card lives against what the screen shows,
// and which keys an answer becomes.
import { describe, expect, it } from "vitest";
import { nextHeld, stepsFor, waitingAt, type HeldPrompt } from "../use-prompt-decision";
import type { ScreenPrompt } from "../screen-prompt";
import type { ChatTurn } from "../components/chat/chat-model";

const BASH: ScreenPrompt = { kind: "permission", question: "Do you want to proceed?", options: ["Yes", "Yes, and don't ask again for npm test commands", "No"] };
const OTHER: ScreenPrompt = { ...BASH, question: "Do you want to make this edit to a.ts?" };
const PLAN: ScreenPrompt = { kind: "plan", question: "Would you like to proceed?", options: ["Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning"] };
const T1: ChatTurn[] = [{ kind: "tool", name: "Bash", arg: "npm test", running: true }];
const T2: ChatTurn[] = [{ kind: "tool", name: "Bash", arg: "npm test", note: "done" }];
/** The same command again, on the next call. */
const T3: ChatTurn[] = [...T2, { kind: "assistant", text: "Once more." }, { kind: "tool", name: "Bash", arg: "npm test", running: true }];
const P1: ChatTurn[] = [{ kind: "assistant", text: "Here is the plan." }, { kind: "plan", text: "# Plan", running: true }];

describe("the call a card answers", () => {
  it("is the last call or plan still waiting in the transcript", () => {
    expect(waitingAt(T1)).toBe(0);
    expect(waitingAt(T2)).toBe(-1);
    expect(waitingAt(T3)).toBe(2);
    expect(waitingAt(P1)).toBe(1);
    expect(waitingAt([])).toBe(-1);
  });
});

describe("the card held against the screen", () => {
  it("a prompt on screen is a card, with the transcript of the moment", () => {
    expect(nextHeld(null, BASH, T1)).toEqual({ prompt: BASH, turns: T1, at: 0 });
  });

  it("the same prompt read again keeps the card, and its words follow the transcript until answered", () => {
    const held = nextHeld(null, BASH, T1)!;
    expect(nextHeld(held, { ...BASH, options: [...BASH.options] }, T1)).toBe(held);
    // The call finished before the prompt left the screen: the card keeps its call.
    expect(nextHeld(held, BASH, T2)).toEqual({ prompt: BASH, turns: T2, at: 0 });
    const sent: HeldPrompt = { ...held, sent: true };
    expect(nextHeld(sent, BASH, T2)).toBe(sent);
  });

  it("a card not answered here follows the same words to the next call", () => {
    const held = nextHeld(null, BASH, T1)!;
    expect(nextHeld(held, BASH, T3)).toEqual({ prompt: BASH, turns: T3, at: 2 });
  });

  it("another prompt is another card, whatever the first one said", () => {
    const sent: HeldPrompt = { prompt: BASH, turns: T1, at: 0, sent: true, outcome: { kind: "stopped", part: false } };
    expect(nextHeld(sent, OTHER, T1)).toEqual({ prompt: OTHER, turns: T1, at: 0 });
  });

  it("a prompt gone takes its card with it, unless it was answered from here", () => {
    expect(nextHeld({ prompt: BASH, turns: T1, at: 0 }, null, T1)).toBeNull();
    expect(nextHeld(null, null, T1)).toBeNull();
    const sent: HeldPrompt = { prompt: BASH, turns: T1, at: 0, sent: true };
    const gone = nextHeld(sent, null, T2)!;
    expect(gone).toEqual({ ...sent, gone: true });
    expect(nextHeld(gone, null, T2)).toBe(gone);
  });

  it("a prompt back on screen before the card went keeps it", () => {
    const gone: HeldPrompt = { prompt: BASH, turns: T1, at: 0, sent: true, gone: true };
    expect(nextHeld(gone, BASH, T1)).toEqual({ prompt: BASH, turns: T1, at: 0, sent: true, gone: false });
  });

  // The same command twice: Claude Code asks the same words for the second
  // call, which the answered card must not take for its own.
  it("the same words on a later call are a new card, even before the first card went", () => {
    const sent: HeldPrompt = { prompt: BASH, turns: T1, at: 0, sent: true };
    expect(nextHeld(sent, BASH, T3)).toEqual({ prompt: BASH, turns: T3, at: 2 });
    const gone: HeldPrompt = { ...sent, gone: true };
    expect(nextHeld(gone, BASH, T3)).toEqual({ prompt: BASH, turns: T3, at: 2 });
  });

  it("while the transcript has not caught up, the answered card stays", () => {
    const sent: HeldPrompt = { prompt: BASH, turns: T1, at: 0, sent: true };
    expect(nextHeld(sent, BASH, T1)).toBe(sent);
    expect(nextHeld(sent, BASH, T2)).toBe(sent);
  });

  it("keep planning with words: the row showing them is still the prompt that was answered", () => {
    const sent: HeldPrompt = { prompt: PLAN, turns: P1, at: 1, sent: true };
    const typed: ScreenPrompt = { ...PLAN, options: [PLAN.options[0], PLAN.options[1], "also cover the admin routes"] };
    expect(nextHeld(sent, typed, P1)).toBe(sent);
    // Not answered from here, the same screen is another prompt: words typed in Term are Term's.
    expect(nextHeld({ prompt: PLAN, turns: P1, at: 1 }, typed, P1)).toEqual({ prompt: typed, turns: P1, at: 1 });
    // Any other row changed is another prompt.
    const other: ScreenPrompt = { ...PLAN, options: ["Yes", PLAN.options[1], PLAN.options[2]] };
    expect(nextHeld(sent, other, P1)).toEqual({ prompt: other, turns: P1, at: 1 });
  });
});

describe("the keys an answer becomes", () => {
  it("a row Chat may answer is its digit, once the prompt shows", () => {
    expect(stepsFor(BASH, { kind: "option", index: 0 })?.[0].keys).toEqual([{ input: "1" }]);
    expect(stepsFor(BASH, { kind: "option", index: 2 })?.[0].keys).toEqual([{ input: "3" }]);
    expect(stepsFor(PLAN, { kind: "option", index: 1 })?.[0].keys).toEqual([{ input: "2" }]);
  });

  it("keep planning with words: the digit, the words, then Enter once they show", () => {
    const steps = stepsFor(PLAN, { kind: "text", index: 2, text: "also cover the admin routes" })!;
    expect(steps.map(s => s.keys)).toEqual([[{ input: "3" }], [{ paste: "also cover the admin routes" }], [{ input: "\r" }]]);
  });

  it("nothing for a locked row, a pick of several, or keep planning with no words", () => {
    expect(stepsFor(BASH, { kind: "option", index: 1 })).toBeNull();
    expect(stepsFor(PLAN, { kind: "option", index: 0 })).toBeNull();
    expect(stepsFor(BASH, { kind: "many", indexes: [0] })).toBeNull();
    expect(stepsFor(PLAN, { kind: "text", index: 2, text: "   " })).toBeNull();
  });
});
