// What a session still does once its turn is over, for Chat's live row
// (live-activity.ts): its background agents, counted from the board's own
// SubagentStart/SubagentStop lifecycle through the shipped reducer, and a
// compaction read off its screen. The row's drawing is live-activity-row.test.ts.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, sweepStaleSessions, STALE_SESSION_MS, type GraphState } from "../reducer";
import { backgroundAgents, chatLive, COMPACTION_MISSES, compactionAfter, liveKey, MENU_MISSES, menuAfter, type CompactionSeen, type MenuSeen } from "../live-activity";
import { stageShowFor } from "../components/terminal/stage-board";
import type { HookEnvelope, HookPayload } from "../types";

const A = "sess-live-a";
const B = "sess-live-b";
const SEC = 1_000;
const MIN = 60_000;
const T0 = 1_800_000_000_000;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = { seq, receivedAt: at, source: "hook", payload: { session_id: A, cwd: "/repo", ...payload } };
  return applyEvent(state, env);
}

/** The events of one wire, applied in order to a fresh board: what a tab
 *  that opens (or reconnects) rebuilds from the replay. */
function replay(events: ReadonlyArray<[number, HookPayload]>): GraphState {
  seq = 0;
  let state = initialState();
  for (const [at, payload] of events) state = send(state, at, payload);
  return state;
}

const start = (id: string, extra: HookPayload = {}): HookPayload => ({ hook_event_name: "SubagentStart", agent_id: id, agent_type: "Explore", ...extra });
const stop = (id: string, extra: HookPayload = {}): HookPayload => ({ hook_event_name: "SubagentStop", agent_id: id, ...extra });
const prompt = (text = "look into the flaky tests"): HookPayload => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const turnEnd: HookPayload = { hook_event_name: "Stop" };
/** The Agent call that launches one in the background: a launcher, not the agent. */
const launch = (id: string, description: string): HookPayload => ({
  hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: id,
  tool_input: { description, subagent_type: "Explore", prompt: "…", run_in_background: true },
});
const launched = (id: string): HookPayload => ({
  hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: id, tool_response: "Async agent launched successfully.",
});

/** The background agents the stage hands Chat for `session`. */
function waitingFor(state: GraphState, session = A): string[] {
  const show = stageShowFor({ kind: "session", id: session }, state.agents, T0 + 60 * MIN);
  return show.kind === "session" ? (show.session.background ?? []).map(a => a.id.slice(session.length + 2)) : [];
}

/** A turn that launches two background agents and ends while both run. */
const TWO: Array<[number, HookPayload]> = [
  [T0, { hook_event_name: "SessionStart" }],
  [T0 + SEC, prompt()],
  [T0 + 2 * SEC, launch("toolu_1", "Find the flaky tests")],
  [T0 + 3 * SEC, start("ag1")],
  [T0 + 3 * SEC, launched("toolu_1")],
  [T0 + 4 * SEC, launch("toolu_2", "Read the CI logs")],
  [T0 + 5 * SEC, start("ag2")],
  [T0 + 5 * SEC, launched("toolu_2")],
  [T0 + 9 * SEC, turnEnd],
];

describe("the background agents a session waits for", () => {
  it("are its subagents still running once the turn is over, oldest first, with what each was asked", () => {
    const state = replay(TWO);
    expect(waitingFor(state)).toEqual(["ag1", "ag2"]);
    const root = state.agents.get(A)!;
    const list = backgroundAgents(root, state.agents.values());
    expect(list.map(a => ({ label: a.label, task: a.task, since: a.since }))).toEqual([
      { label: "Explore", task: "Find the flaky tests", since: T0 + 3 * SEC },
      { label: "Explore", task: "Read the CI logs", since: T0 + 5 * SEC },
    ]);
  });

  it("never count the call that launched one: no SubagentStart, no agent", () => {
    const state = replay([
      [T0, { hook_event_name: "SessionStart" }], [T0 + SEC, prompt()],
      [T0 + 2 * SEC, launch("toolu_1", "Find the flaky tests")], [T0 + 3 * SEC, launched("toolu_1")],
      [T0 + 9 * SEC, turnEnd],
    ]);
    expect(waitingFor(state)).toEqual([]);
  });

  it("go one by one as each stops, in whatever order they finish, and none is left after the last", () => {
    const second = replay([...TWO, [T0 + 30 * SEC, stop("ag2")]]);
    expect(waitingFor(second)).toEqual(["ag1"]);
    const both = replay([...TWO, [T0 + 30 * SEC, stop("ag2")], [T0 + 40 * SEC, stop("ag1")]]);
    expect(waitingFor(both)).toEqual([]);
    // The other order ends the same.
    expect(waitingFor(replay([...TWO, [T0 + 30 * SEC, stop("ag1")], [T0 + 40 * SEC, stop("ag2")]]))).toEqual([]);
  });

  it("count a Start or a Stop delivered twice once, and a Start replayed after its Stop not at all", () => {
    const twice = replay([...TWO, [T0 + 6 * SEC, start("ag1")], [T0 + 30 * SEC, stop("ag2")], [T0 + 30 * SEC + 500, stop("ag2")]]);
    expect(waitingFor(twice)).toEqual(["ag1"]);
    const replayed = replay([...TWO, [T0 + 30 * SEC, stop("ag2")], [T0 + 31 * SEC, start("ag2")]]);
    expect(waitingFor(replayed), "a Start re-delivered inside the window does not bring it back").toEqual(["ag1"]);
  });

  it("never count one whose Stop overtook its Start", () => {
    const state = replay([
      [T0, { hook_event_name: "SessionStart" }], [T0 + SEC, prompt()],
      [T0 + 2 * SEC, stop("fast")], [T0 + 2 * SEC + 400, start("fast")],
      [T0 + 9 * SEC, turnEnd],
    ]);
    expect(waitingFor(state)).toEqual([]);
  });

  it("take one that failed or was stopped off the list once its SubagentStop comes, and the stale sweep settles one whose Stop never comes", () => {
    // SubagentStop carries no outcome: finished, failed or stopped, it is over.
    expect(waitingFor(replay([...TWO, [T0 + 20 * SEC, stop("ag1")]]))).toEqual(["ag2"]);
    const lost = replay(TWO);
    expect(waitingFor(lost)).toEqual(["ag1", "ag2"]);
    sweepStaleSessions(lost, T0 + 9 * SEC + STALE_SESSION_MS + SEC, STALE_SESSION_MS);
    expect(waitingFor(lost)).toEqual([]);
  });

  it("are the same after a reconnect: the replay rebuilds the board they are read from", () => {
    const events: Array<[number, HookPayload]> = [...TWO, [T0 + 30 * SEC, stop("ag2")]];
    const first = replay(events);
    // The same wire again, with the replayed copies of its last events on top.
    const again = replay([...events, [T0 + 9 * SEC, turnEnd], [T0 + 30 * SEC, stop("ag2")]]);
    expect(waitingFor(again)).toEqual(waitingFor(first));
  });

  it("are each session's own", () => {
    seq = 0;
    let state = initialState();
    for (const [at, payload] of TWO) state = send(state, at, payload);
    for (const [at, payload] of TWO) state = send(state, at + 100, { ...payload, session_id: B });
    state = send(state, T0 + 30 * SEC, { ...stop("ag1"), session_id: B });
    state = send(state, T0 + 31 * SEC, { ...stop("ag2"), session_id: B });
    expect(waitingFor(state, A)).toEqual(["ag1", "ag2"]);
    expect(waitingFor(state, B)).toEqual([]);
  });

  it("while a turn runs, are only the ones that outlived an earlier turn: the turn's own subagents are its work", () => {
    const next = replay([...TWO, [T0 + 20 * SEC, prompt("and now the docs")], [T0 + 21 * SEC, start("fg")]]);
    const root = next.agents.get(A)!;
    expect(root.state).toBe("active");
    expect(backgroundAgents(root, next.agents.values()).map(a => a.id)).toEqual([`${A}::ag1`, `${A}::ag2`]);
    // A first turn has no earlier end: its subagents are all its own.
    const first = replay(TWO.slice(0, 5));
    expect(backgroundAgents(first.agents.get(A)!, first.agents.values())).toEqual([]);
  });

  it("count while the session waits at its prompt, and are gone once it ends", () => {
    const idle = replay([...TWO, [T0 + 70 * SEC, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }]]);
    expect(waitingFor(idle)).toEqual(["ag1", "ag2"]);
    const ended = replay([...TWO, [T0 + 70 * SEC, { hook_event_name: "SessionEnd", reason: "exit" }]]);
    expect(waitingFor(ended)).toEqual([]);
  });

  it("are left out of what the stage hands over when there are none", () => {
    const show = stageShowFor({ kind: "session", id: A }, replay(TWO.slice(0, 2)).agents, T0 + MIN);
    expect(show.kind === "session" && "background" in show.session).toBe(false);
  });
});

describe("the header's sentence for a session waiting on background agents", () => {
  it("says how many still run, in place of when the turn ended", () => {
    const state = replay(TWO);
    const show = stageShowFor({ kind: "session", id: A }, state.agents, T0 + 10 * SEC);
    expect(show.kind === "session" && show.session.status).toMatchObject({ state: "idle", arg: "2 background agents running" });
    const done = replay([...TWO, [T0 + 30 * SEC, stop("ag1")], [T0 + 31 * SEC, stop("ag2")]]);
    const after = stageShowFor({ kind: "session", id: A }, done.agents, T0 + 32 * SEC);
    expect(after.kind === "session" && after.session.status.arg).not.toMatch(/background/);
  });
});

describe("a compaction, read off the screen", () => {
  const NOW = 5_000_000;
  const compacting = (seconds?: number) => ({ words: "Compacting conversation…", ...(seconds === undefined ? {} : { seconds }) });

  it("begins when the spinner says so, from its own clock when it prints one", () => {
    expect(compactionAfter(null, compacting(37), NOW)).toEqual({ since: NOW - 37 * SEC, missed: 0 });
    expect(compactionAfter(null, compacting(), NOW)).toEqual({ since: NOW, missed: 0 });
  });

  it("keeps its start while it lasts, the same object when nothing moved", () => {
    const seen = compactionAfter(null, compacting(3), NOW)!;
    expect(compactionAfter(seen, compacting(4), NOW + SEC)).toBe(seen);
  });

  it("holds through a frame without the line, and ends after COMPACTION_MISSES reads without it", () => {
    let seen: CompactionSeen | null = compactionAfter(null, compacting(), NOW);
    for (let i = 1; i < COMPACTION_MISSES; i++) {
      seen = compactionAfter(seen, null, NOW + i * SEC);
      expect(seen?.since).toBe(NOW);
    }
    // Seen again: the misses start over.
    expect(compactionAfter(seen, compacting(), NOW + 3 * SEC)).toEqual({ since: NOW, missed: 0 });
    expect(compactionAfter(seen, null, NOW + 3 * SEC)).toBeNull();
  });

  it("ends at once when the spinner says something else: the next turn's work", () => {
    const seen = compactionAfter(null, compacting(), NOW);
    expect(compactionAfter(seen, { words: "Pondering…", seconds: 1 }, NOW + SEC)).toBeNull();
  });

  it("is nothing on a screen that never showed one", () => {
    expect(compactionAfter(null, null, NOW)).toBeNull();
    expect(compactionAfter(null, { words: "Pondering…" }, NOW)).toBeNull();
  });
});

describe("a menu only Term shows, read off the screen", () => {
  const SAVE = ["Looks good — save it", "Discard and exit"];

  it("begins at once with its choices", () => {
    expect(menuAfter(null, SAVE)).toEqual({ options: SAVE, missed: 0 });
  });

  it("is the same object while the same choices are read again", () => {
    const seen = menuAfter(null, SAVE)!;
    expect(menuAfter(seen, [...SAVE])).toBe(seen);
  });

  it("holds through a frame without it, and ends after MENU_MISSES reads without it", () => {
    let seen: MenuSeen | null = menuAfter(null, SAVE);
    for (let i = 1; i < MENU_MISSES; i++) {
      seen = menuAfter(seen, null);
      expect(seen?.options).toEqual(SAVE);
    }
    // Seen again: the misses start over.
    expect(menuAfter(seen, SAVE)).toEqual({ options: SAVE, missed: 0 });
    expect(menuAfter(seen, null)).toBeNull();
  });

  it("is another menu at once when the choices change", () => {
    const seen = menuAfter(null, SAVE);
    expect(menuAfter(seen, ["Yes", "No"])).toEqual({ options: ["Yes", "No"], missed: 0 });
  });

  it("is nothing on a screen that never showed one", () => {
    expect(menuAfter(null, null)).toBeNull();
  });
});

describe("what Chat's live row says", () => {
  const agent = { id: "s::a", label: "Explore", since: 1 };

  it("is nothing while Chat's working row speaks for the turn", () => {
    expect(chatLive({ agents: [agent], compacting: { since: 1 }, working: true })).toBeUndefined();
  });

  it("is nothing when nothing runs after the turn", () => {
    expect(chatLive({ agents: [], compacting: null, working: false })).toBeUndefined();
    expect(chatLive({ working: false })).toBeUndefined();
  });

  it("says the background agents and a compaction, each when there is one", () => {
    expect(chatLive({ agents: [agent], working: false })).toEqual({ agents: [agent] });
    expect(chatLive({ compacting: { since: 7 }, working: false })).toEqual({ compacting: { since: 7 } });
    expect(chatLive({ agents: [agent], compacting: { since: 7 }, working: false })).toEqual({ compacting: { since: 7 }, agents: [agent] });
  });

  it("says a menu only Term shows, first, with its choices", () => {
    expect(chatLive({ menu: ["Yes", "No"], working: false })).toEqual({ menu: { options: ["Yes", "No"] } });
    expect(chatLive({ menu: ["Yes", "No"], agents: [agent], working: false })).toEqual({ menu: { options: ["Yes", "No"] }, agents: [agent] });
    expect(chatLive({ menu: null, working: false })).toBeUndefined();
    expect(chatLive({ menu: ["Yes", "No"], working: true })).toBeUndefined();
  });

  it("is known by what it says, not by its clocks", () => {
    expect(liveKey(undefined)).toBe("");
    expect(liveKey({ compacting: { since: 1 } })).toBe(liveKey({ compacting: { since: 2 } }));
    expect(liveKey({ agents: [agent] })).not.toBe(liveKey({ agents: [agent, { ...agent, id: "s::b" }] }));
    expect(liveKey({ menu: { options: ["Yes", "No"] } })).not.toBe(liveKey(undefined));
    expect(liveKey({ menu: { options: ["Yes", "No"] } })).not.toBe(liveKey({ menu: { options: ["Save", "Discard"] } }));
  });
});
