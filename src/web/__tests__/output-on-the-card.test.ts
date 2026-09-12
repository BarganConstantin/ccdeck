// What the card does with the one signal that has no hook behind it.
//
// The server's transcript watch reports a completed block of the model's own
// output — see output-watch.mjs — and this is what the graph makes of it. The
// point of the whole chain is the chart: it counted tool calls alone, so the
// 16.5% of measured time the model spends reading, reasoning and writing drew
// as a flat line, and the element a reader checks to answer "is this thing
// doing anything" answered no while the answer was yes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-output";
const CWD = "/repo";
const T0 = 1_700_000_000_000;
const SEC = 1_000;

let seq = 0;
function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  return applyEvent(state, {
    seq, receivedAt: at, source: "hook",
    payload: { session_id: SESSION, cwd: CWD, ...payload },
  } as HookEnvelope);
}

/** A live session that has said one thing and is now working. */
function live(): GraphState {
  seq = 0;
  let s = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider: "claude" });
  return send(s, T0 - 5 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "go", provider: "claude" });
}

const root = (s: GraphState) => [...s.agents.values()].find(a => a.kind === "root")!;
const output = (s: GraphState, at: number, kind = "thinking") =>
  send(s, at, { hook_event_name: "OutputObserved", kind, at } as unknown as HookPayload);

describe("a block of the model's own output reaches the graph", () => {
  it("keeps a tool call out of the chart, because the card already marks it", () => {
    // A `tool_use` block IS the tool call, written within a second of the
    // PreToolUse the chart already has a mark for. Measured on one real
    // session: 378 tool calls and 378 `tool_use` blocks — the same events. Two
    // marks for one would draw the chart at double height for exactly the half
    // of the work that was never invisible.
    let s = live();
    s = output(s, T0, "tool_use");
    expect(root(s).lastOutputAt, "it still counts as the session having moved").toBe(T0);
    expect(root(s).outputs ?? [], "and contributes nothing to the chart").toEqual([]);
    s = output(s, T0 + SEC, "thinking");
    expect(root(s).outputs).toEqual([T0 + SEC]);
  });

  it("records when it landed and what it was", () => {
    const s = output(live(), T0);
    expect(root(s).lastOutputAt).toBe(T0);
    expect(root(s).lastOutputKind).toBe("thinking");
    expect(root(s).outputs).toEqual([T0]);
  });

  it("keeps the block's own stamp rather than when the deck heard it", () => {
    // A tick can deliver a block that landed while the deck was busy. Dating it
    // `now` would report old work as having just happened, which is the one
    // thing this signal must never do — it exists to answer "is it working NOW".
    let s = live();
    s = send(s, T0 + 30 * SEC, { hook_event_name: "OutputObserved", kind: "thinking", at: T0 } as unknown as HookPayload);
    expect(root(s).lastOutputAt).toBe(T0);
  });

  it("never moves backwards", () => {
    // Ticks are ordered by the clock they are polled on, not by the stamps in
    // the files, so a slow read can deliver an older block after a newer one. A
    // card whose "last worked" went backwards would report a live session as
    // going stale.
    let s = output(live(), T0 + 10 * SEC);
    s = output(s, T0 + 2 * SEC);
    expect(root(s).lastOutputAt).toBe(T0 + 10 * SEC);
    expect(root(s).outputs).toEqual([T0 + 10 * SEC]);
  });

  it("collects the recent ones and drops what the chart cannot see", () => {
    // The chart looks at sixty seconds. Anything older is dropped on the way in
    // rather than accumulated for hours and filtered on every render.
    let s = live();
    s = output(s, T0);
    s = output(s, T0 + 45 * SEC);
    s = output(s, T0 + 90 * SEC);
    expect(root(s).outputs).toEqual([T0 + 45 * SEC, T0 + 90 * SEC]);
  });

  it("draws the window edge where the chart draws it", () => {
    // The renderer marks a stamp when `age < WINDOW_MS`, so one at exactly
    // sixty seconds is not drawn. Keeping it here would hand the chart a mark
    // it refuses, and the two would disagree about what a minute is.
    let s = live();
    s = output(s, T0);
    s = output(s, T0 + 60 * SEC);
    expect(root(s).outputs).toEqual([T0 + 60 * SEC]);
  });

  it("stays bounded on a session that runs for hours", () => {
    let s = live();
    for (let i = 0; i < 300; i++) s = output(s, T0 + i * 100);
    expect(root(s).outputs!.length).toBeLessThanOrEqual(64);
  });

  it("takes the three kinds it knows and refuses anything else", () => {
    for (const kind of ["thinking", "text", "tool_use"]) {
      expect(root(output(live(), T0, kind)).lastOutputKind).toBe(kind);
    }
    for (const junk of ["tool_result", "", "THINKING", "other"]) {
      expect(root(output(live(), T0, junk)).lastOutputAt, junk).toBeUndefined();
    }
  });

  it("manifests no node for a session the graph has never heard of", () => {
    // A watch tick reads a file on disk. It must not be able to conjure a card
    // out of one.
    const s = applyEvent(initialState(), {
      seq: 1, receivedAt: T0, source: "hook",
      payload: { session_id: "never-seen", hook_event_name: "OutputObserved", kind: "thinking", at: T0 },
    } as unknown as HookEnvelope);
    expect(s.agents.size).toBe(0);
  });
});

describe("the chart stops calling a working session idle", () => {
  const node = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");

  it("marks a block the same way it marks a tool call", () => {
    expect(node).toContain("for (const t of tools) mark(t.startedAt);");
    expect(node).toMatch(/for \(const at of outputs \?\? \[\]\) mark\(at\);/);
  });

  it("draws itself for a session that has produced but called nothing", () => {
    // The case the whole change is about: a minute of thinking with no tool in
    // it used to render no chart at all, because the chart was gated on tools.
    expect(node).toContain('(data.tools.length > 0 || (data.outputs?.length ?? 0) > 0)');
  });

  it("says what it counted, both halves", () => {
    // A chart moving on a card with no tool call in a minute is otherwise a
    // reader's puzzle.
    expect(node).toContain("of thinking and writing");
    expect(node).toContain("const blockMarks = total - toolMarks;");
  });
});
