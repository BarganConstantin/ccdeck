// #677: the card carries a marker for a session the deck never saw begin — a
// dashed border and a `?` chip titled "No SessionStart captured — synthesised"
// — and for eleven months it could not light. `applyEvent` calls `resolveOwner`
// above the switch for every event, and that fallback created the root with
// `synthetic: false`, so by the time `ensureSubagent` asked for a synthetic one
// the root already existed and `ensureRoot` ignores the argument on a node it
// did not create. Every one of the 45 (event kind x id shape) first-event
// combinations produced `false`. Nothing in this suite asserted on the flag, so
// it died silently in the phantom-subagent fix (96970b2) and stayed dead.
//
// The condition it names did NOT go away with its detection, which is why this
// file revives the flag rather than burying it. Four ordinary routes to a
// session the deck is drawing without having seen its `SessionStart`:
//
//   * The Clear button. `/api/clear` truncates events.jsonl to zero and
//     broadcasts `__clear`; every session that was running carries on, and the
//     next event it emits is the first this deck has ever seen of it.
//   * Starting the deck after Claude Code. Hook POSTs are fire-and-forget —
//     README says so where it explains why the deck only self-restarts after
//     30s of quiet — so everything a live session emitted before this deck was
//     listening was dropped on the floor by the OS, not queued.
//   * Log rotation. events.jsonl rolls to events.jsonl.1 at 50MB and boot
//     replays only the current file, so a long session's start is archived out
//     of the replay while the session is still running.
//   * A tab attaching to a busy deck. The SSE connect is replayed the ring
//     buffer, which holds MAX_BUFFER (2000) events and no more.
//
// In all four the card shows a start time counted from whenever the deck tuned
// in, an empty prompt list and a tool history missing its beginning — and
// without the marker it is drawn exactly like a session watched from the first
// byte. So the rule pinned here is "did we see this session BEGIN", which is
// what the tooltip has always claimed, rather than the narrower "was this node
// conjured by a child event" the flag was originally written as.
//
// No DOM in this suite, so the reducer is driven directly and the two render
// sites are checked by reading the source. Those two halves are the trap this
// file exists to close: the flag going unreachable again fails the reducer
// tests, and the flag being computed but no longer drawn fails the render ones.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const SESSION = "sess-677";

let seq = 0;

function send(state: GraphState, payload: HookPayload, opts: { replay?: boolean } = {}): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: 1_000 + seq,
    source: "hook",
    payload: { session_id: SESSION, ...payload },
    ...(opts.replay ? { replay: true } : {}),
  };
  return applyEvent(state, env);
}

function fresh(): GraphState {
  seq = 0;
  return initialState();
}

const root = (state: GraphState) => state.agents.get(SESSION)!;

// ── The probe from the report, as an assertion ────────────────────────────
//
// Every event kind the reducer knows, against each of the three id shapes a
// payload can carry, each one the very first event of a brand-new session. The
// report ran this and got `false` 45 times out of 45; the point of keeping it
// is that a regression which re-flattens the answer fails HERE, naming the kind
// and the shape that stopped distinguishing a start from a mid-stream arrival,
// rather than being noticed a year later by someone reading the render code.

/** Kinds handled above the switch that return before any node is created. They
 *  are enrichment the server derives FROM a session it is already drawing, and
 *  a node conjured by one would be a session that never emitted a hook. */
const OBSERVED_ONLY = ["ModelObserved", "ContextObserved", "SessionNamed", "UsageObserved"];

const KINDS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "SessionEnd", "Notification",
  ...OBSERVED_ONLY,
  "Unknown",
];

const SHAPES: Array<[string, Partial<HookPayload>]> = [
  ["agent_id", { agent_id: "a1", agent_type: "explorer" }],
  ["parent_tool_use_id", { parent_tool_use_id: "toolu_1" }],
  ["neither", {}],
];

describe("the joined-late marker, over every first event a session can have", () => {
  for (const kind of KINDS) {
    for (const [shapeName, shape] of SHAPES) {
      it(`${kind} + ${shapeName}`, () => {
        const state = send(fresh(), { hook_event_name: kind, tool_name: "Bash", ...shape });
        const node = state.agents.get(SESSION);

        if (OBSERVED_ONLY.includes(kind)) {
          expect(node, `${kind} must not conjure a session node at all`).toBeUndefined();
          return;
        }

        expect(node, `${kind} + ${shapeName} should have created the root`).toBeDefined();
        expect(
          node!.synthetic === true,
          `a session whose first event is ${kind} (${shapeName}) ${kind === "SessionStart" ? "was watched from the start" : "was joined late"}`,
        ).toBe(kind !== "SessionStart");
      });
    }
  }
});

describe("a session the deck watched from the first byte", () => {
  it("is never marked, through a whole lifecycle", () => {
    let state = send(fresh(), { hook_event_name: "SessionStart", cwd: "/repo" });
    expect(root(state).synthetic).toBeFalsy();

    for (const payload of [
      { hook_event_name: "UserPromptSubmit", prompt: "run the tests" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
      { hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" },
      { hook_event_name: "Stop" },
      { hook_event_name: "SessionEnd" },
    ] as HookPayload[]) {
      state = send(state, payload);
      expect(root(state).synthetic, `${payload.hook_event_name} must not mark a watched session`).toBeFalsy();
    }
  });

  it("stays unmarked when a subagent starts under it", () => {
    // `ensureSubagent` asks for a synthetic root, and must not get one: the
    // root here exists BECAUSE we saw it start. `ensureRoot` honouring the
    // argument only on creation is what makes that hold.
    let state = send(fresh(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "explorer" });
    expect(root(state).synthetic).toBeFalsy();
  });
});

describe("a session the deck joined after it had started", () => {
  it("is marked from its first event and stays marked", () => {
    // The deck came up while this session was mid-turn: no SessionStart was
    // ever POSTed to it, and none is coming.
    let state = send(fresh(), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", cwd: "/repo" });
    expect(root(state).synthetic).toBe(true);

    for (const payload of [
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
      { hook_event_name: "UserPromptSubmit", prompt: "and again" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" },
      { hook_event_name: "Stop" },
    ] as HookPayload[]) {
      state = send(state, payload);
      expect(root(state).synthetic, `${payload.hook_event_name} is not evidence the deck saw the session start`).toBe(true);
    }
  });

  it("keeps the marker when the session's own events arrive, not just a child's", () => {
    // The line this replaces cleared the flag and rewrote `startedAt` the
    // moment any root-attributed event landed. A `UserPromptSubmit` proves the
    // session is there; it says nothing about whether we watched it begin, and
    // `startedAt` corrected to the time of THAT event would be a second
    // invented number on top of the first.
    let state = send(fresh(), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
    const startedAt = root(state).startedAt;
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "carry on" });
    expect(root(state).synthetic).toBe(true);
    expect(root(state).startedAt).toBe(startedAt);
  });

  it("is marked when the first thing seen is a subagent starting", () => {
    // The subagent-first session from the report. The root is a node the deck
    // inferred from a child; the subagent itself was announced, so it is not.
    const state = send(fresh(), { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "explorer" });
    expect(root(state).synthetic).toBe(true);
    const sub = [...state.agents.values()].find(a => a.kind === "subagent");
    expect(sub, "SubagentStart should have created the subagent").toBeDefined();
    expect(sub!.synthetic, "a subagent exists only because its start was seen").toBeFalsy();
  });

  it("gives the marker up when a SessionStart turns up late", () => {
    // Order independence is the reducer's contract: hook POSTs race, and a
    // replay can deliver out of order. A start that arrives after the event
    // that created the node still means we have the session's beginning.
    let state = send(fresh(), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
    expect(root(state).synthetic).toBe(true);
    state = send(state, { hook_event_name: "SessionStart", cwd: "/repo" });
    expect(root(state).synthetic).toBeFalsy();
  });
});

describe("the four ways the deck ends up joining late", () => {
  it("Clear: the log is truncated under a session that keeps running", () => {
    // `/api/clear` truncates events.jsonl and broadcasts `__clear`. The
    // sessions do not stop, so the deck picks each of them up mid-stream.
    let state = send(fresh(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
    expect(root(state).synthetic).toBeFalsy();

    state = send(state, { hook_event_name: "__clear", cwd: "" });
    expect(state.agents.size, "__clear empties the canvas").toBe(0);

    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" });
    expect(root(state).synthetic, "everything before the clear is gone from this deck").toBe(true);
  });

  it("a boot replay that begins partway through the session", () => {
    // Rotation archives events.jsonl to .1 at 50MB and only the current file is
    // replayed; the ring buffer a fresh tab is handed is bounded the same way.
    // Either way the first record about this session is a mid-turn one, and
    // `replay` on the envelope does not change the answer.
    let state = fresh();
    for (const payload of [
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t9" },
      { hook_event_name: "UserPromptSubmit", prompt: "next" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t10" },
    ] as HookPayload[]) {
      state = send(state, payload, { replay: true });
    }
    expect(root(state).synthetic).toBe(true);
  });

  it("a session that only ever says goodbye", () => {
    // The deck attached with seconds to spare: a `Stop` and a `SessionEnd` are
    // the whole of what it has. The card still draws, and still says so.
    let state = send(fresh(), { hook_event_name: "Stop" });
    state = send(state, { hook_event_name: "SessionEnd" });
    expect(root(state).synthetic).toBe(true);
  });
});

// ── The other half: the flag has to still be drawn ────────────────────────
//
// A flag that is computed correctly and rendered nowhere is the same dead
// weight as one that renders and can never light, so both sites and both CSS
// rules are pinned. If a future change deletes the badge, the reducer tests
// above keep passing and these do not.
describe("the card draws it", () => {
  const node = read("src", "web", "components", "AgentNode.tsx");
  const css = read("src", "web", "styles.css");

  it("puts the synthetic class on the node", () => {
    expect(node).toMatch(/data\.synthetic \? "synthetic"/);
  });

  it("renders the ? chip with the sentence that explains it", () => {
    expect(node).toContain("No SessionStart captured");
    expect(node).toMatch(/data\.synthetic &&/);
    expect(node).toContain('className="synth-tag"');
  });

  it("styles both of them", () => {
    expect(css).toContain(".agent-node.synthetic");
    expect(css).toContain(".agent-node .synth-tag");
  });
});
