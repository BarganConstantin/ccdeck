// What an agent says it is working through: the task list it keeps for itself
// (#2157). The deck drew every tool call and still could not say what a session
// was FOR — a run of Edits and a Bash reads the same whether it is step two of
// a migration or the last of a refactor. The agent's own checklist says that,
// in its own words, and it is already on the wire as tool calls.
//
// Three dialects, all read off calls the deck already receives:
//
//   - Claude Code's TodoWrite: the whole list on every call,
//     `{ todos: [{ content, status, activeForm }] }`. Each agent keeps its own
//     (the CLI filed them per agent), so it lands on the agent that wrote it.
//
//   - Claude Code's Task tools, which replace TodoWrite on current CLIs:
//     TaskCreate `{ subject, description, activeForm? }` answers with
//     `{ task: { id, subject } }` — the id exists only in the RESULT —
//     TaskUpdate `{ taskId, status?, subject?, activeForm? }` patches one by id
//     and `status: "deleted"` removes it, and TaskList answers with the whole
//     list. One list per session, shared with its subagents (a subagent's
//     TaskUpdate moves the root's tasks), so these land on the session's root.
//     All three are read off the OUTCOME: the create's id and the update's
//     `success` are only known there, and every one of them is keyed by task
//     id, so a second copy of an outcome changes nothing.
//
//   - Codex's update_plan: the whole list on every call,
//     `{ explanation?, plan: [{ step, status }] }`, on the agent that wrote it.
//
// Shapes checked against the Agent SDK's TodoWriteInput / TaskCreateOutput /
// TaskUpdateInput / TaskListOutput, codex-rs's UpdatePlanArgs, and the hook
// payloads this machine's deck logged. Claude Code repairs `id` / `task_id` to
// `taskId` and `active_form` to `activeForm` before it runs a TaskUpdate but
// not in what the hook sees, so both spellings are read.
//
// No model is asked anything. Every word shown is one the agent wrote.
import type { AgentNodeData, AgentPlan, PlanItem, PlanStatus } from "./types";

/** The tools whose input (the first two) or result (the Task tools) is a plan. */
const WHOLE_LIST_CALLS = new Set(["TodoWrite", "update_plan"]);
const TASK_CALLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

function statusOf(raw: unknown): PlanStatus | null {
  return raw === "pending" || raw === "in_progress" || raw === "completed" ? raw : null;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** A call's input, parsed when it arrived as JSON text (a Codex function call
 *  whose arguments did not parse upstream). */
function objectOf(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/** TodoWrite's or update_plan's list, as items — or null when the input is not
 *  one, so a malformed call leaves the plan the agent had. */
function wholeList(name: string, input: unknown): { items: PlanItem[]; note?: string } | null {
  const o = objectOf(input);
  if (!o) return null;
  const rows = name === "TodoWrite" ? o.todos : o.plan;
  if (!Array.isArray(rows)) return null;
  const items: PlanItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const t = name === "TodoWrite" ? text(r.content) : text(r.step);
    const status = statusOf(r.status);
    if (!t || !status) continue;
    const active = text(r.activeForm ?? r.active_form);
    items.push(active ? { text: t, status, active } : { text: t, status });
  }
  const note = name === "update_plan" ? text(o.explanation) : "";
  return note ? { items, note } : { items };
}

/** A new plan object, so a card memoised on its data sees the change. */
function planWith(items: PlanItem[], at: number, note?: string): AgentPlan {
  return note ? { items, at, note } : { items, at };
}

/**
 * A plan call starting (PreToolUse): TodoWrite and update_plan, whose input IS
 * the new list, on the agent that made the call. The Task tools wait for their
 * outcome — see applyPlanOutcome.
 *
 * An older list never replaces a newer one. A call re-delivered after its id
 * has slid out of the tool window reaches here as new, and replaying it would
 * put back a list the agent has since rewritten; `at` is the event's own time.
 */
export function applyPlanCall(agent: AgentNodeData, name: string | undefined, input: unknown, at: number): void {
  if (!name || !WHOLE_LIST_CALLS.has(name)) return;
  if (agent.plan && at < agent.plan.at) return;
  const list = wholeList(name, input);
  if (!list) return;
  agent.plan = planWith(list.items, at, list.note);
}

/** The id a TaskUpdate or TaskGet names, under any spelling the hook carries. */
function taskIdOf(o: Record<string, unknown> | null): string {
  if (!o) return "";
  const raw = o.taskId ?? o.id ?? o.task_id;
  return typeof raw === "number" ? String(raw) : text(raw);
}

/**
 * A Task tool's outcome (PostToolUse only — a failed call changed nothing), on
 * the session's root. TaskCreate adds the task under the id its result
 * assigned; TaskUpdate patches it, or takes it away on `deleted`; TaskList is
 * the whole list and replaces what the deck had pieced together, which is how
 * a deck that joined a session late, or lost events to a restart, catches up;
 * TaskGet refreshes the one task it read.
 */
export function applyPlanOutcome(root: AgentNodeData, name: string | undefined, input: unknown, response: unknown, at: number): void {
  if (!name || !TASK_CALLS.has(name)) return;
  const inp = objectOf(input);
  const out = objectOf(response);
  const items = root.plan?.items ?? [];
  const byId = (id: string) => items.findIndex(i => i.id === id);

  if (name === "TaskCreate") {
    const task = objectOf(out?.task);
    const id = taskIdOf(task);
    const subject = text(task?.subject) || text(inp?.subject);
    if (!id || !subject) return;
    const active = text(inp?.activeForm ?? inp?.active_form);
    const at0 = byId(id);
    const item: PlanItem = { id, text: subject, status: at0 >= 0 ? items[at0].status : "pending", ...(active ? { active } : {}) };
    const next = items.slice();
    if (at0 >= 0) next[at0] = item; else next.push(item);
    root.plan = planWith(next, Math.max(at, root.plan?.at ?? at), root.plan?.note);
    return;
  }

  if (name === "TaskUpdate") {
    // The result says whether the patch took. A hook that cut the response
    // leaves only the input to go on, which is what the call asked for.
    if (out && out.success === false) return;
    const id = taskIdOf(out) || taskIdOf(inp);
    if (!id) return;
    const status = inp?.status;
    const i = byId(id);
    if (status === "deleted") {
      if (i < 0) return;
      root.plan = planWith(items.filter((_, k) => k !== i), Math.max(at, root.plan?.at ?? at), root.plan?.note);
      return;
    }
    const subject = text(inp?.subject);
    const active = text(inp?.activeForm ?? inp?.active_form);
    const s = statusOf(status) ?? statusOf((objectOf(out?.statusChange))?.to);
    // A task the deck never saw created is added only when the update names
    // it: an id alone would draw as "Task 3", a line the agent never wrote.
    if (i < 0) {
      if (!subject) return;
      const item: PlanItem = { id, text: subject, status: s ?? "pending", ...(active ? { active } : {}) };
      root.plan = planWith([...items, item], Math.max(at, root.plan?.at ?? at), root.plan?.note);
      return;
    }
    const prev = items[i];
    const item: PlanItem = {
      ...prev,
      ...(subject ? { text: subject } : {}),
      ...(s ? { status: s } : {}),
      ...(active ? { active } : {}),
    };
    const next = items.slice();
    next[i] = item;
    root.plan = planWith(next, Math.max(at, root.plan?.at ?? at), root.plan?.note);
    return;
  }

  if (name === "TaskList") {
    if (!out || !Array.isArray(out.tasks)) return;
    if (root.plan && at < root.plan.at) return;
    const next: PlanItem[] = [];
    for (const row of out.tasks) {
      const r = objectOf(row);
      const id = taskIdOf(r);
      const subject = text(r?.subject);
      const status = statusOf(r?.status);
      if (!id || !subject || !status) continue;
      // The list carries no activeForm; the one the deck already had for the
      // task still describes it.
      const known = items.find(x => x.id === id);
      next.push(known?.active ? { id, text: subject, status, active: known.active } : { id, text: subject, status });
    }
    root.plan = planWith(next, at, root.plan?.note);
    return;
  }

  // TaskGet: one task, or null when the id is gone.
  const task = out && "task" in out ? objectOf(out.task) : undefined;
  const id = taskIdOf(task ?? null) || taskIdOf(inp);
  const i = id ? byId(id) : -1;
  if (i < 0) return;
  if (task === null) {
    root.plan = planWith(items.filter((_, k) => k !== i), Math.max(at, root.plan?.at ?? at), root.plan?.note);
    return;
  }
  const subject = text(task?.subject);
  const status = statusOf(task?.status);
  if (!subject && !status) return;
  const next = items.slice();
  next[i] = { ...items[i], ...(subject ? { text: subject } : {}), ...(status ? { status } : {}) };
  root.plan = planWith(next, Math.max(at, root.plan?.at ?? at), root.plan?.note);
}

/** What a surface with one line says about a plan. */
export interface PlanSummary {
  done: number;
  total: number;
  /** The step being worked on — the in-progress one, worded as the agent
   *  words it while working ("Writing the migration") — or else the next one
   *  waiting, or null once everything is done. */
  current: string | null;
  /** True when `current` is a step waiting rather than one under way. */
  next: boolean;
  allDone: boolean;
}

/** The plan as one line's worth, or null when there is nothing to say: no plan,
 *  or a list the agent emptied. */
export function planSummary(plan: AgentPlan | undefined | null): PlanSummary | null {
  const items = plan?.items ?? [];
  if (items.length === 0) return null;
  const done = items.filter(i => i.status === "completed").length;
  const working = items.find(i => i.status === "in_progress");
  const waiting = working ? null : items.find(i => i.status === "pending");
  const current = working ? (working.active || working.text) : waiting ? waiting.text : null;
  return { done, total: items.length, current, next: !working && !!waiting, allDone: done === items.length };
}

/** "3/7 · Writing the migration", "3/7 · next: Run the tests", "7/7 · done". */
export function planLine(s: PlanSummary): string {
  const count = `${s.done}/${s.total}`;
  if (s.allDone || !s.current) return `${count} · done`;
  return `${count} · ${s.next ? "next: " : ""}${s.current}`;
}

/** The same, for a screen reader, which reads "3/7" as a date. */
export function planSpoken(s: PlanSummary): string {
  const count = `plan ${s.done} of ${s.total} done`;
  if (s.allDone || !s.current) return count;
  return `${count}, ${s.next ? "next" : "now"}: ${s.current}`;
}

/** Every step on a line of its own, marked done, under way or waiting — the
 *  tooltip the card's row and the session list's line both carry. */
export function planTitle(items: readonly PlanItem[]): string {
  return items.map(i => `${i.status === "completed" ? "✓" : i.status === "in_progress" ? "▸" : "○"} ${i.text}`).join("\n");
}
