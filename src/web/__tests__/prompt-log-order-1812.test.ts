// #1812: a restart that re-sent a prompt the tab had missed, followed by prompts
// it already had, recorded every one of those later prompts twice.
//
// The duplicate check walks the prompt list newest first and stops at the first
// entry older than its window, which is only sound on a list sorted by time. The
// list was in arrival order, so the missed prompt — appended after the newer
// ones — sat at the tail, the check for each later copy stopped on it, and each
// copy was pushed: "one, three, four, two, three, four". The list is kept in
// time order now, so a late prompt is filed in its place and the walk is sound.
//
// Two forms: the merge on its own, as a pure function over a list, and the same
// replay through the real reducer with the epochs a restart stamps.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, PROMPT_REDELIVERY_WINDOW_MS, type GraphState } from "../reducer";
import { recordPrompt } from "../redelivery";
import { lastWorkedAt } from "../remove-node";
import type { HookEnvelope, HookPayload, PromptEntry } from "../types";

const T0 = 1_700_000_000_000;
const at = { one: T0 + 60_000, two: T0 + 120_000, three: T0 + 180_000, four: T0 + 240_000 };
type Name = keyof typeof at;

/** The tab's view: one, three and four arrived live; two was missed. Then the
 *  restart re-sent the log's tail, two, three and four, under a new epoch. */
const LIVE: Name[] = ["one", "three", "four"];
const RESENT: Name[] = ["two", "three", "four"];

function merge(order: Name[]): PromptEntry[] {
  const prompts: PromptEntry[] = [];
  for (const name of order) recordPrompt(prompts, at[name], name);
  return prompts;
}

/** Every ordering of `items`. Seven items is 5,040 of them, which is cheap. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

describe("the prompt-log merge (#1812)", () => {
  it("records a missed prompt once, in its place, and the prompts after it once", () => {
    expect(merge([...LIVE, ...RESENT]).map(p => p.text)).toEqual(["one", "two", "three", "four"]);
  });

  it("says which copies it recorded and which it recognised", () => {
    const prompts = merge(LIVE);
    expect(RESENT.map(name => recordPrompt(prompts, at[name], name))).toEqual([true, false, false]);
  });

  it("lands on the same list whatever order the copies arrive in", () => {
    const want = ["one", "two", "three", "four"];
    for (const order of permutations([...LIVE, ...RESENT])) {
      expect(merge(order).map(p => p.text), order.join(",")).toEqual(want);
    }
  });

  it("keeps the list in time order", () => {
    const prompts = merge([...LIVE, ...RESENT]);
    expect(prompts.map(p => p.at)).toEqual([at.one, at.two, at.three, at.four]);
  });

  it("still records the same words typed again once a turn has passed", () => {
    const prompts = merge(["one"]);
    expect(recordPrompt(prompts, at.one + PROMPT_REDELIVERY_WINDOW_MS + 1, "one")).toBe(true);
    // And a copy of the first, arriving after the second, is still the first.
    expect(recordPrompt(prompts, at.one + 5, "one")).toBe(false);
    expect(prompts).toHaveLength(2);
  });
});

describe("the same replay through the reducer (#1812)", () => {
  let seq = 0;
  let epoch = "boot-A";
  const send = (state: GraphState, payload: HookPayload, receivedAt: number) =>
    applyEvent(state, {
      seq: ++seq, receivedAt, source: "hook", epoch,
      payload: { session_id: "s1", ...payload },
    } as HookEnvelope);
  const prompt = (state: GraphState, name: Name) =>
    send(state, { hook_event_name: "UserPromptSubmit", prompt: name }, at[name]);

  function replay(live: Name[], resent: Name[]): GraphState {
    seq = 0;
    epoch = "boot-A";
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
    for (const name of live) state = prompt(state, name);
    // The restarted process numbers its log from 1 again under a new epoch.
    epoch = "boot-B";
    for (const name of resent) state = prompt(state, name);
    return state;
  }

  it("records each submission once, in time order", () => {
    const root = replay(LIVE, RESENT).agents.get("s1")!;
    expect(root.prompts.map(p => p.text)).toEqual(["one", "two", "three", "four"]);
  });

  it("ends in the same list when nothing was missed", () => {
    const root = replay(["one", "two", "three", "four"], RESENT).agents.get("s1")!;
    expect(root.prompts.map(p => p.text)).toEqual(["one", "two", "three", "four"]);
  });

  it("ends in the same list when the missed prompt arrived first instead", () => {
    const root = replay(["two", "one", "three", "four"], RESENT).agents.get("s1")!;
    expect(root.prompts.map(p => p.text)).toEqual(["one", "two", "three", "four"]);
  });

  it("reads the newest prompt as the last work, with an older one filed late", () => {
    const root = replay(LIVE, ["two"]).agents.get("s1")!;
    expect(lastWorkedAt(root)).toBe(at.four);
  });
});
