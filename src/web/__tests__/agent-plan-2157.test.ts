// #2157: what each agent is working on, from the checklist it keeps for itself.
//
// The deck drew every tool call and could not say what a session was FOR. The
// agent's own task list says it, and it is already on the wire: Claude Code's
// TodoWrite and Task tools, and Codex's update_plan. These cases drive the real
// reducer with the payload shapes those tools actually send — checked against
// the Agent SDK's TodoWriteInput / TaskCreateOutput / TaskUpdateInput /
// TaskListOutput, codex-rs's UpdatePlanArgs, and hook payloads a deck on this
// machine logged — and then read the result the way the card, the session
// list, the zoomed-out face and a screen reader do.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { planLine, planSpoken, planSummary } from "../agent-plan";
import { buildRows } from "../components/SessionList";
import { faceSignal } from "../node-face";
import { agentAriaLabel } from "../agent-copy";
import { MAX_TOOLS_PER_AGENT } from "../tool-calls";

const SID = "s-plan";
let seq = 0;
let t = 1_800_000_000_000;

function send(state: GraphState, payload: Partial<HookPayload>, at = (t += 1_000)): void {
  applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: SID, ...payload } as HookPayload } as HookEnvelope);
}

/** A tool call that opens and settles, as the hook delivers both halves. */
function call(state: GraphState, id: string, tool_name: string, tool_input: unknown, tool_response?: unknown, extra: Partial<HookPayload> = {}): void {
  send(state, { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: id, ...extra });
  send(state, { hook_event_name: "PostToolUse", tool_name, tool_input, tool_use_id: id, tool_response, ...extra });
}

function board(): GraphState {
  seq = 0;
  const state = initialState();
  send(state, { hook_event_name: "SessionStart", cwd: "/work/repo" } as Partial<HookPayload>);
  send(state, { hook_event_name: "UserPromptSubmit", prompt: "ship it" } as Partial<HookPayload>);
  return state;
}

const root = (state: GraphState): AgentNodeData => state.agents.get(SID)!;

/** A subagent, announced the way the deck needs it: only SubagentStart makes one. */
const SUB = { agent_id: "sub-1", agent_type: "Explore" } as Partial<HookPayload>;
function startSubagent(state: GraphState): AgentNodeData {
  send(state, { hook_event_name: "SubagentStart", ...SUB } as Partial<HookPayload>);
  return [...state.agents.values()].find(a => a.kind === "subagent")!;
}
const texts = (a: AgentNodeData) => (a.plan?.items ?? []).map(i => `${i.status}:${i.text}`);

/** TaskCreate as Claude Code sends it: the id exists only in the result. */
function create(state: GraphState, n: number, subject: string, activeForm?: string, extra: Partial<HookPayload> = {}): void {
  call(state, `tc-${n}`, "TaskCreate", { subject, description: `${subject}, in detail`, ...(activeForm ? { activeForm } : {}) },
    { task: { id: String(n), subject } }, extra);
}

/** TaskUpdate as Claude Code sends it, and the result it answers with. */
function update(state: GraphState, n: number, input: Record<string, unknown>, ok = true, extra: Partial<HookPayload> = {}): void {
  call(state, `tu-${n}-${seq}`, "TaskUpdate", { taskId: String(n), ...input },
    ok ? { success: true, taskId: String(n), updatedFields: Object.keys(input) } : { success: false, taskId: String(n), updatedFields: [], error: "Task not found" },
    extra);
}

describe("TodoWrite: the whole list, every call", () => {
  it("is the agent's plan as the newest call left it", () => {
    const s = board();
    call(s, "tw-1", "TodoWrite", { todos: [
      { content: "Read the schema", status: "in_progress", activeForm: "Reading the schema" },
      { content: "Write the migration", status: "pending", activeForm: "Writing the migration" },
    ] });
    expect(texts(root(s))).toEqual(["in_progress:Read the schema", "pending:Write the migration"]);
    // The step under way, in the words the agent uses while doing it.
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/2 · Reading the schema");

    // A rewrite replaces the list; it is not merged into it.
    call(s, "tw-2", "TodoWrite", { todos: [
      { content: "Read the schema", status: "completed", activeForm: "Reading the schema" },
      { content: "Write the migration", status: "completed", activeForm: "Writing the migration" },
      { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
    ] });
    expect(texts(root(s))).toEqual(["completed:Read the schema", "completed:Write the migration", "in_progress:Run the tests"]);
    expect(planLine(planSummary(root(s).plan)!)).toBe("2/3 · Running the tests");
  });

  it("does not let an older list replace a newer one", () => {
    // A copy of an old call whose id has left the tool window arrives as a new
    // call. Its list is history, and putting it back would rewind the plan.
    const s = board();
    call(s, "tw-new", "TodoWrite", { todos: [{ content: "Done thing", status: "completed", activeForm: "x" }] });
    const at = root(s).plan!.at;
    send(s, { hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_use_id: "tw-old",
      tool_input: { todos: [{ content: "Done thing", status: "pending", activeForm: "x" }] } }, at - 60_000);
    expect(texts(root(s))).toEqual(["completed:Done thing"]);
  });

  it("lands on the subagent that wrote it, not on its session", () => {
    // Each agent kept its own TodoWrite list, so a subagent's is its own.
    const s = board();
    const sub = startSubagent(s);
    call(s, "tw-sub", "TodoWrite", { todos: [{ content: "Search the tests", status: "in_progress", activeForm: "Searching" }] },
      undefined, SUB);
    expect(root(s).plan).toBeUndefined();
    expect(texts(sub)).toEqual(["in_progress:Search the tests"]);
  });

  it("ignores a malformed call rather than emptying the plan", () => {
    const s = board();
    call(s, "tw-1", "TodoWrite", { todos: [{ content: "Keep me", status: "pending", activeForm: "x" }] });
    call(s, "tw-2", "TodoWrite", { todo: "not the shape" });
    call(s, "tw-3", "TodoWrite", { todos: [{ content: "", status: "pending" }, { content: "No status" }] });
    // tw-3 is a list, with nothing usable in it: an empty plan, which says nothing.
    expect(root(s).plan?.items).toEqual([]);
    expect(planSummary(root(s).plan)).toBeNull();
  });
});

describe("the Task tools: one task at a time, on the session's list", () => {
  it("adds each task under the id its result gave it, and patches it by that id", () => {
    const s = board();
    create(s, 1, "Read the schema", "Reading the schema");
    create(s, 2, "Write the migration", "Writing the migration");
    create(s, 3, "Run the tests");
    expect(texts(root(s))).toEqual(["pending:Read the schema", "pending:Write the migration", "pending:Run the tests"]);
    // Nothing under way yet: the line names the next step, as the next one.
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/3 · next: Read the schema");

    update(s, 1, { status: "in_progress" });
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/3 · Reading the schema");
    update(s, 1, { status: "completed" });
    update(s, 2, { status: "in_progress" });
    expect(planLine(planSummary(root(s).plan)!)).toBe("1/3 · Writing the migration");
    expect(root(s).plan!.items.map(i => i.id)).toEqual(["1", "2", "3"]);
  });

  it("takes a deleted task away, and keeps a refused update from moving anything", () => {
    const s = board();
    create(s, 1, "Keep");
    create(s, 2, "Drop");
    update(s, 2, { status: "deleted" });
    expect(texts(root(s))).toEqual(["pending:Keep"]);
    // `success: false` is the tool saying the patch did not happen.
    update(s, 1, { status: "completed" }, false);
    expect(texts(root(s))).toEqual(["pending:Keep"]);
  });

  it("reads the id and activeForm under the spellings the hook carries unrepaired", () => {
    // Claude Code maps `id` / `task_id` to `taskId` and `active_form` to
    // `activeForm` before it runs the call, but the hook sees what the model sent.
    const s = board();
    create(s, 1, "Read the schema");
    call(s, "tu-alias", "TaskUpdate", { task_id: "1", status: "in_progress", active_form: "Reading it now" }, undefined);
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/1 · Reading it now");
  });

  it("is the session's list, so a subagent's update moves the root's task", () => {
    // Subagents share their session's task list: the one the root created.
    const s = board();
    create(s, 1, "Search the codebase");
    const sub = startSubagent(s);
    update(s, 1, { status: "completed" }, true, SUB);
    // The call itself is drawn on the subagent that made it; the list it moved is the session's.
    expect(sub.tools.some(tc => tc.name === "TaskUpdate")).toBe(true);
    expect(texts(root(s))).toEqual(["completed:Search the codebase"]);
    expect(sub.plan).toBeUndefined();
  });

  it("adds a task it never saw created only when the update names it", () => {
    // A deck that joined late has no create to go on. An id alone would draw as
    // a line the agent never wrote, so it waits for a subject.
    const s = board();
    update(s, 7, { status: "in_progress" });
    expect(root(s).plan).toBeUndefined();
    update(s, 8, { status: "in_progress", subject: "Deploy" });
    expect(texts(root(s))).toEqual(["in_progress:Deploy"]);
  });

  it("does not add a task twice when the same outcome arrives twice", () => {
    const s = board();
    create(s, 1, "Once");
    send(s, { hook_event_name: "PostToolUse", tool_name: "TaskCreate", tool_use_id: "tc-1",
      tool_input: { subject: "Once" }, tool_response: { task: { id: "1", subject: "Once" } } });
    expect(texts(root(s))).toEqual(["pending:Once"]);
  });

  it("drops a create that failed", () => {
    const s = board();
    send(s, { hook_event_name: "PreToolUse", tool_name: "TaskCreate", tool_use_id: "tc-x", tool_input: { subject: "Never made" } });
    send(s, { hook_event_name: "PostToolUseFailure", tool_name: "TaskCreate", tool_use_id: "tc-x", tool_response: "boom" });
    expect(root(s).plan).toBeUndefined();
  });

  it("catches up from TaskList, which is the whole list, keeping the words for the step under way", () => {
    const s = board();
    create(s, 1, "Read the schema", "Reading the schema");
    update(s, 1, { status: "in_progress" });
    // Two tasks the deck never saw created, and one it did, as TaskList reports them.
    call(s, "tl-1", "TaskList", {}, { tasks: [
      { id: "1", subject: "Read the schema", status: "in_progress", blockedBy: [] },
      { id: "2", subject: "Write the migration", status: "pending", blockedBy: [] },
      { id: "3", subject: "Run the tests", status: "pending", blockedBy: ["2"] },
    ] });
    expect(texts(root(s))).toEqual(["in_progress:Read the schema", "pending:Write the migration", "pending:Run the tests"]);
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/3 · Reading the schema");
  });
});

describe("Codex's update_plan", () => {
  it("is the whole list, step and status, with its explanation kept as a note", () => {
    const s = board();
    call(s, "call_1", "update_plan", {
      explanation: "Starting with the parser",
      plan: [
        { step: "Parse the config", status: "in_progress" },
        { step: "Wire the flag", status: "pending" },
      ],
    }, "Plan updated", { provider: "codex" } as Partial<HookPayload>);
    expect(texts(root(s))).toEqual(["in_progress:Parse the config", "pending:Wire the flag"]);
    expect(root(s).plan!.note).toBe("Starting with the parser");
    expect(planLine(planSummary(root(s).plan)!)).toBe("0/2 · Parse the config");
  });

  it("reads arguments that arrived as JSON text", () => {
    const s = board();
    call(s, "call_2", "update_plan", JSON.stringify({ plan: [{ step: "Only step", status: "completed" }] }), "Plan updated");
    expect(texts(root(s))).toEqual(["completed:Only step"]);
  });
});

describe("what the surfaces say", () => {
  it("says done when every step is", () => {
    const s = board();
    call(s, "tw", "TodoWrite", { todos: [
      { content: "A", status: "completed", activeForm: "a" },
      { content: "B", status: "completed", activeForm: "b" },
    ] });
    const plan = planSummary(root(s).plan)!;
    expect(plan.allDone).toBe(true);
    expect(planLine(plan)).toBe("2/2 · done");
    expect(planSpoken(plan)).toBe("plan 2 of 2 done");
  });

  it("says nothing at all for an agent that keeps no list", () => {
    const s = board();
    call(s, "b1", "Bash", { command: "ls" }, { stdout: "" });
    expect(root(s).plan).toBeUndefined();
    expect(planSummary(root(s).plan)).toBeNull();
    expect(buildRows(s, t)[0].plan).toBeNull();
    expect(agentAriaLabel(root(s), t)).not.toMatch(/plan/);
  });

  it("puts the root's plan on its session list row, the count heard as words", () => {
    const s = board();
    create(s, 1, "Read the schema", "Reading the schema");
    create(s, 2, "Write the migration");
    update(s, 1, { status: "in_progress" });
    const [row] = buildRows(s, t);
    expect(row.plan).toMatchObject({ done: 0, total: 2, current: "Reading the schema" });
    expect(row.planTitle).toBe("▸ Read the schema\n○ Write the migration");
    expect(agentAriaLabel(root(s), t)).toContain("plan 0 of 2 done, now: Reading the schema");
  });

  it("gives a running card's far face the step, ahead of the call it has open", () => {
    const s = board();
    call(s, "tw", "TodoWrite", { todos: [
      { content: "A", status: "completed", activeForm: "a" },
      { content: "Write the migration", status: "in_progress", activeForm: "Writing the migration" },
    ] });
    send(s, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "open-edit", tool_input: { file_path: "/x.ts" } });
    const words = { sayWaiting: () => "", describeCall: () => ({ name: "Edit", subject: "x.ts" }) };
    expect(faceSignal(root(s), undefined, words)).toEqual({ tone: "muted", long: "1/2 · Writing the migration", short: "1/2 done" });
    // Once the turn is over the face goes back to saying nothing about it.
    send(s, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "open-edit", tool_response: {} });
    send(s, { hook_event_name: "Stop" } as Partial<HookPayload>);
    expect(faceSignal(root(s), undefined, words)).toBeNull();
  });
});

describe("a plan outlives the tool window", () => {
  it("is still whole after the calls that wrote it have been released and trimmed", () => {
    // A call's input is let go after a window of newer calls, and only the last
    // MAX_TOOLS_PER_AGENT calls are kept at all. A plan written in the first
    // minute is still the plan an hour later.
    const s = board();
    create(s, 1, "Read the schema", "Reading the schema");
    create(s, 2, "Write the migration");
    update(s, 1, { status: "in_progress" });
    for (let i = 0; i < MAX_TOOLS_PER_AGENT + 20; i++) call(s, `bash-${i}`, "Bash", { command: `echo ${i}` }, { stdout: String(i) });
    expect(root(s).tools.some(tc => tc.name === "TaskCreate")).toBe(false);
    expect(texts(root(s))).toEqual(["in_progress:Read the schema", "pending:Write the migration"]);
    // And the next update still finds its task by id.
    update(s, 1, { status: "completed" });
    expect(planLine(planSummary(root(s).plan)!)).toBe("1/2 · next: Write the migration");
  });
});
