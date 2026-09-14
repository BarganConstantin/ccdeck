// #842: a card in a fresh tab was labelled `g-p-6aa65d20d024819183fe5a6484a9955c`.
// A root is named by its directory's basename and a subagent by the type it was
// spawned as, and either can be an id. A name that looks like one now gives way
// to the nearest name that does not.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import { looksLikeId, readableBasename } from "../readable-name";
import type { GraphState, HookEnvelope, HookPayload } from "../types";

const HASHED = "g-p-6aa65d20d024819183fe5a6484a9955c";

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

describe("what looks like an id (#842)", () => {
  it("catches the reported name, a bare hash and a uuid", () => {
    expect(looksLikeId(HASHED)).toBe(true);
    expect(looksLikeId("6aa65d20d024819183fe5a6484a9955c")).toBe(true);
    expect(looksLikeId("a45bac81-9209-49b3-a719-49eebeee97ea")).toBe(true);
  });

  it("leaves names people choose alone, digits and dashes included", () => {
    for (const name of ["agents-deck", "vcrm-core", "general-purpose", "Explore", "api-v2", "2024-q3-report", "impeccable"]) {
      expect(looksLikeId(name), name).toBe(false);
    }
  });
});

describe("the readable end of a path (#842)", () => {
  it("is the basename when that is a name", () => {
    expect(readableBasename("/Users/me/code/agents-deck")).toBe("agents-deck");
    expect(readableBasename("C:\\code\\vcrm-core")).toBe("vcrm-core");
  });

  it("walks up past segments that are ids", () => {
    expect(readableBasename(`/work/api/.claude/worktrees/${HASHED}`)).toBe("worktrees");
    expect(readableBasename("/tmp/a45bac81-9209-49b3-a719-49eebeee97ea/scratchpad")).toBe("scratchpad");
  });

  it("still answers when every segment is an id", () => {
    expect(readableBasename(`/${HASHED}`)).toBe(HASHED);
    expect(readableBasename(undefined)).toBeUndefined();
  });
});

describe("the reducer's labels (#842)", () => {
  it("names a session in a hashed directory by the nearest readable one", () => {
    seq = 0;
    const s = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: `/work/api/.claude/worktrees/${HASHED}` }, 1_000);
    const root = s.agents.get("s1")!;
    expect(root.label).toBe("worktrees");
    expect(root.cwdBasename).toBe("worktrees");
    // The path itself is untouched: the detail rail and the tooltip still show it.
    expect(root.cwd).toBe(`/work/api/.claude/worktrees/${HASHED}`);
  });

  it("calls a subagent whose type is an id a subagent", () => {
    seq = 0;
    let s = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/work/api" }, 1_000);
    s = send(s, "s1", { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: HASHED }, 2_000);
    const sub = [...s.agents.values()].find(a => a.kind === "subagent")!;
    expect(sub.label).toBe("subagent");
  });

  it("keeps a subagent's real type", () => {
    seq = 0;
    let s = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/work/api" }, 1_000);
    s = send(s, "s1", { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" }, 2_000);
    expect([...s.agents.values()].find(a => a.kind === "subagent")!.label).toBe("Explore");
  });
});
