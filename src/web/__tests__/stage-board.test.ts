// The board, put in the shapes the terminal stage draws (components/terminal/
// stage-board.ts): the header's sentence from the root's state, the session's
// name, hue and pane address, the asks run in the keys bar's terms, and the
// projects New session offers.
import { describe, expect, it } from "vitest";
import type { BlockedSession } from "../ambient-counts";
import { barArrival, barAsks, boardFactsFor, boardProjects, stageShowFor } from "../components/terminal/stage-board";
import { sessionHue } from "../session-hue";
import type { AgentNodeData, ToolCall, WaitingBlock } from "../types";
import type { AsksView } from "../use-asks";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function agent(id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    id, sessionId: id, kind: "root", label: "paycore", state: "done", tools: [], prompts: [],
    startedAt: NOW - 30 * MIN, provider: "claude", cwd: "/w/paycore", cwdBasename: "paycore",
    ...extra,
  } as AgentNodeData;
}

const sub = (id: string, sessionId: string, state: AgentNodeData["state"]) =>
  agent(`${sessionId}::${id}`, { sessionId, kind: "subagent", label: id, state });

const tool = (name: string, startedAt: number, extra: Partial<ToolCall> = {}): ToolCall =>
  ({ id: `${name}-${startedAt}`, name, inputPreview: "", startedAt, ...extra }) as ToolCall;

const wait = (kind: WaitingBlock["kind"], since: number, extra: Partial<WaitingBlock> = {}): WaitingBlock =>
  ({ kind, message: "", since, ...extra });

describe("the facts the header's sentence is built from", () => {
  it("counts a wait only when it is one the topbar counts — a permission or a question", () => {
    const asked = boardFactsFor(agent("s", { waiting: wait("permission", NOW - 6 * MIN, { tool: { name: "Bash", preview: "git push" } }) }), []);
    expect(asked.waiting).toEqual({ since: NOW - 6 * MIN, tool: "Bash", detail: "git push" });
    const idle = boardFactsFor(agent("s", { waiting: wait("idle", NOW - MIN) }), []);
    expect(idle.waiting, "an idle prompt is not on you").toBeNull();
    expect(idle.yourTurn, "the card's Your turn, for the header to agree with").toBe(true);
    expect(asked.yourTurn).toBe(false);
  });

  it("names the open call the way the card's bubbles do, and only while the turn runs", () => {
    const busy = agent("s", { state: "active", tools: [tool("Read", NOW - 9000, { endedAt: NOW - 8000 }), tool("Bash", NOW - 5000)] });
    const facts = boardFactsFor(busy, []);
    expect(facts.active).toBe(true);
    expect(facts.tool?.name).toBe("Bash");
    expect(facts.tool?.startedAt).toBe(NOW - 5000);
    expect(boardFactsFor({ ...busy, state: "done" }, []).tool, "a finished turn names no call").toBeNull();
  });

  it("counts the subagents still running", () => {
    const facts = boardFactsFor(agent("s", { state: "active" }), [sub("a", "s", "active"), sub("b", "s", "done"), sub("c", "s", "active")]);
    expect(facts.subagentsLive).toBe(2);
  });

  it("calls a session nobody has asked anything yet fresh", () => {
    expect(boardFactsFor(agent("s"), []).fresh).toBe(true);
    expect(boardFactsFor(agent("s", { firstPrompt: "fix the tests" }), []).fresh).toBe(false);
  });

  it("does not call a session fresh once a turn has ended, even one a ! shell line started", () => {
    expect(boardFactsFor(agent("s", { lastTurnEndAt: NOW - MIN }), []).fresh).toBe(false);
  });
});

describe("what the stage shows", () => {
  it("shows a board session by its face's name, its hue and its pane's address", () => {
    const root = agent("s1", { model: "claude-opus-5-5", state: "active", tools: [tool("Bash", NOW - 3000)] });
    const show = stageShowFor({ kind: "session", id: "s1" }, new Map([["s1", root]]), NOW);
    expect(show.kind).toBe("session");
    if (show.kind !== "session") return;
    expect(show.session.ref).toEqual({ sessionId: "s1", provider: "claude", cwd: "/w/paycore" });
    expect(show.session.name).toBe("paycore");
    expect(show.session.hue).toBe(sessionHue("s1"));
    expect(show.session.model).toBe("claude-opus-5-5");
    expect(show.session.status.state).toBe("working");
    expect(show.session.status.tool).toBe("Bash");
  });

  it("says waiting and for how long, in the face's word, never blocked", () => {
    const root = agent("s1", { waiting: wait("permission", NOW - 6 * MIN), state: "active" });
    const show = stageShowFor({ kind: "session", id: "s1" }, new Map([["s1", root]]), NOW);
    if (show.kind !== "session") throw new Error("not a session");
    expect(show.session.status).toMatchObject({ state: "waiting", phrase: "waiting", emphasis: "6m" });
    expect(JSON.stringify(show)).not.toMatch(/blocked/);
  });

  it("gives an ended session its age, for the end bar", () => {
    const root = agent("s1", { closedAt: NOW - 14 * MIN });
    const show = stageShowFor({ kind: "session", id: "s1" }, new Map([["s1", root]]), NOW);
    if (show.kind !== "session") throw new Error("not a session");
    expect(show.session.endedAgo).toBe("14m ago");
    expect(show.session.status.state).toBe("ended");
  });

  it("quotes the last prompt, one line of it, on the card for a session it cannot attach", () => {
    const root = agent("s1", { prompts: [{ at: NOW - MIN, text: "first" }, { at: NOW, text: "\n  ship the release\nthen tag it" }] });
    const show = stageShowFor({ kind: "session", id: "s1" }, new Map([["s1", root]]), NOW);
    if (show.kind !== "session") throw new Error("not a session");
    expect(show.session.context?.prompt).toBe("ship the release");
    expect(show.session.context?.fact).toContain("Claude Code · /w/paycore");
  });

  it("addresses a Codex session as Codex", () => {
    const root = agent("s1", { provider: "codex" });
    const show = stageShowFor({ kind: "session", id: "s1" }, new Map([["s1", root]]), NOW);
    if (show.kind !== "session") throw new Error("not a session");
    expect(show.session.ref.provider).toBe("codex");
  });

  it("still shows a session the board has lost, by id, with nothing it cannot back", () => {
    const show = stageShowFor({ kind: "session", id: "0123456789abcdef" }, new Map(), NOW);
    if (show.kind !== "session") throw new Error("not a session");
    expect(show.session.name).toBe("01234567");
    expect(show.session.status).toEqual({ state: "none", phrase: "" });
  });

  it("names a launch after its folder, and shows nothing for the empty stage", () => {
    expect(stageShowFor({ kind: "launch", agent: "codex", cwd: "/w/vicinae/", key: "l1" }, new Map(), NOW))
      .toEqual({ kind: "launch", agent: "codex", cwd: "/w/vicinae/", name: "vicinae", hue: sessionHue("l1"), key: "l1" });
    expect(stageShowFor({ kind: "empty" }, new Map(), NOW)).toEqual({ kind: "empty" });
    expect(stageShowFor(null, new Map(), NOW)).toEqual({ kind: "empty" });
  });
});

describe("the asks run, in the keys bar's terms", () => {
  const waiting: BlockedSession[] = [
    { id: "s-travel", label: "travel", waiting: wait("permission", NOW - 2 * MIN, { tool: { name: "Bash", preview: "" } }) },
  ];
  const noRun: AsksView = { track: [], position: null, resumed: null, next: null, clear: false, arrival: null };

  it("is nothing while there is no run", () => {
    expect(barAsks(noRun, waiting, NOW)).toBeNull();
  });

  it("counts from zero where the run counts from one, and marks the segment that just joined", () => {
    const view: AsksView = {
      track: [{ id: "a", state: "done", fresh: false }, { id: "b", state: "now", fresh: false }, { id: "c", state: "todo", fresh: true }],
      position: { index: 2, total: 3 }, resumed: null, next: null, clear: false, arrival: null,
    };
    expect(barAsks(view, waiting, NOW)).toEqual({
      segments: ["done", "now", "todo"], freshIndex: 2, position: { index: 1, total: 3 }, resumed: null, next: null, clear: false,
    });
  });

  it("offers the next ask with how long it has waited and on what", () => {
    const view: AsksView = {
      track: [{ id: "s-paycore", state: "done", fresh: false }, { id: "s-travel", state: "todo", fresh: false }],
      position: null, resumed: { id: "s-paycore", label: "paycore" }, next: { id: "s-travel", label: "travel" }, clear: false, arrival: null,
    };
    expect(barAsks(view, waiting, NOW)).toMatchObject({
      resumed: "paycore", freshIndex: null, next: { name: "travel", waited: "2m", tool: "Bash" },
    });
  });

  it("notes an ask that arrived with no run going, once, with its tool", () => {
    expect(barArrival({ ...noRun, arrival: { id: "s-travel", label: "travel", until: NOW + 8000 } }, waiting))
      .toEqual({ name: "travel", tool: "Bash" });
    expect(barArrival(noRun, waiting)).toBeNull();
  });
});

describe("the projects New session offers", () => {
  it("is every folder a session on the board ran in, most recently heard from first, the stage's own leading", () => {
    const agents = [
      agent("a", { cwd: "/w/paycore", lastEventAt: NOW - 5 * MIN }),
      agent("b", { cwd: "/w/travel", lastEventAt: NOW - MIN }),
      agent("c", { cwd: "/w/paycore", lastEventAt: NOW - 20 * MIN }),
      sub("x", "b", "active"),
      agent("d", { cwd: "relative/path", lastEventAt: NOW }),
      agent("e", { cwd: "/w/ccdeck", lastEventAt: NOW - 50 * MIN }),
    ];
    expect(boardProjects(agents).map(p => p.cwd)).toEqual(["/w/travel", "/w/paycore", "/w/ccdeck"]);
    expect(boardProjects(agents, "/w/ccdeck").map(p => p.cwd)).toEqual(["/w/ccdeck", "/w/travel", "/w/paycore"]);
    expect(boardProjects(agents)[0]).toEqual({ cwd: "/w/travel", name: "travel", hue: sessionHue("b") });
  });
});
