// Which agent an event belongs to, and the nodes that answer the question.
//
// CC's tool-call hooks carry no agent_id of their own, so most traffic has to be
// attributed: to the subagent the payload names when that subagent exists, else
// to the deepest one still live on the session's stack, else to the root. A root
// is created by the first event heard from its session; a subagent only ever by
// its own `SubagentStart`, so a stray key on a terminal event cannot conjure one.
import { rootAgentId, subagentIdFor, type GraphState } from "./graph-state";
import { looksLikeId, readableBasename } from "./readable-name";
import { emptyUsage } from "./usage-wire";
import type { AgentNodeData, HookPayload } from "./types";

/** The name a card shows for a directory: its basename, or the nearest
 *  ancestor's when the basename is an id (#842). Every caller is a label —
 *  `cwdBasename` and a root's default name — and nothing keys on it. */
function basename(p?: string): string | undefined {
  return readableBasename(p);
}

export function subagentLabel(p: HookPayload): string {
  const type = p.agent_type ?? p.subagent_type;
  // A type with an id in it names nothing a reader can use (#842).
  return type && !looksLikeId(type) ? type : "subagent";
}

/** The key under which this event explicitly identifies a subagent, or null
 *  when it belongs to the root session. */
export function explicitSubagentKey(p: HookPayload): string | null {
  if (p.agent_id) return p.agent_id;
  if (p.parent_tool_use_id) return p.parent_tool_use_id;
  return null;
}

/** A node's directory, from the first payload that names one. Later payloads
 *  never move it: the directory a card was first drawn under is the one it
 *  keeps. */
export function adoptCwd(a: AgentNodeData, p: HookPayload): void {
  if (!a.cwd && p.cwd) { a.cwd = p.cwd; a.cwdBasename = basename(p.cwd); }
}

/** A root still under its placeholder name takes its directory's. */
export function adoptRootLabel(root: AgentNodeData, p: HookPayload): void {
  if (root.label === "session" && p.cwd) root.label = basename(p.cwd) ?? "session";
}

/** A subagent still under its placeholder name takes the type the payload
 *  spawned it as, when that type is a name a reader can use. */
function adoptSubagentLabel(a: AgentNodeData, p: HookPayload): void {
  const lbl = subagentLabel(p);
  if (lbl && (a.label === "subagent" || !a.label)) a.label = lbl;
}

export function ensureRoot(state: GraphState, sessionId: string, now: number, synthetic: boolean): AgentNodeData {
  const id = rootAgentId(sessionId);
  let a = state.agents.get(id);
  if (a) return a;
  a = {
    id,
    sessionId,
    label: "session",
    kind: "root",
    state: "active",
    startedAt: now,
    // Seeded here as well as stamped in applyEvent, because the event that
    // creates a root is handled after the stamp has already run and found
    // nothing to write to. A root that was never stamped would read as silent
    // since epoch and be reaped on the first tick after it appeared.
    lastEventAt: now,
    tools: [],
    prompts: [],
    toolCount: 0,
    childCount: 0,
    synthetic,
    usage: emptyUsage(),
  };
  state.agents.set(id, a);
  return a;
}

/** Look up an existing subagent without creating one. Returns null if the
 *  subagent has never been announced via SubagentStart. Used by resolveOwner
 *  so a stray `parent_tool_use_id` on a Stop / PostToolUse / Notification
 *  payload can't manufacture a phantom node at end-of-life. */
export function lookupSubagent(state: GraphState, sessionId: string, key: string, p: HookPayload): AgentNodeData | null {
  const id = subagentIdFor(sessionId, key);
  const a = state.agents.get(id);
  if (!a) return null;
  adoptCwd(a, p);
  adoptSubagentLabel(a, p);
  return a;
}

/** Resolve which agent owns this event:
 *  - If the payload explicitly names a subagent (agent_id / parent_tool_use_id)
 *    AND that subagent already exists, that subagent is the owner.
 *  - Otherwise, attribute to the deepest currently-active subagent of this
 *    session if any, else to the root session.
 *
 *  Critically, this never CREATES a subagent — only SubagentStart does.
 *  Earlier versions auto-created on first sight of any explicit key, which
 *  manufactured a phantom subagent every time CC included a stray
 *  parent_tool_use_id on a terminal event (Stop, PostToolUse, Notification).
 */
export function resolveOwner(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const sessionId = p.session_id ?? "unknown";
  const explicit = explicitSubagentKey(p);

  if (explicit) {
    const sub = lookupSubagent(state, sessionId, explicit, p);
    if (sub) return sub;
    // Explicit key but no matching subagent — fall through to stack/root
    // attribution rather than fabricating one.
  }

  // No (resolvable) explicit subagent. Attribute to top of active stack.
  const stack = state.activeSubagentStack.get(sessionId);
  const topKey = stack && stack.length > 0 ? stack[stack.length - 1] : null;
  if (topKey) {
    const sub = state.agents.get(subagentIdFor(sessionId, topKey));
    if (sub) {
      adoptCwd(sub, p);
      return sub;
    }
  }
  // Fall back to root, creating it if this is the first we have heard of the
  // session.
  //
  // A root CREATED here by anything other than a `SessionStart` is a session
  // the deck joined after it had already begun, and `synthetic` says so (#677).
  // The condition is ordinary, not exotic: the Clear button truncates
  // events.jsonl and broadcasts `__clear` while every live session keeps
  // running; hook POSTs are fire-and-forget, so everything a session emitted
  // before this deck was listening is simply gone; the log rotates to
  // `events.jsonl.1` at 50MB and only the current file is replayed at boot; and
  // a tab attaching to a busy deck is replayed the ring buffer, which holds the
  // last MAX_BUFFER events and no more. In all of them the card's start time,
  // prompt list and early tool calls are missing, and without the marker it is
  // drawn identically to a session watched from the first byte.
  //
  // This is deliberately "did we see the session BEGIN", not the narrower
  // "was this node conjured by a child event" the flag was born as. An event
  // from the root's own context is not evidence either way — a `PreToolUse`
  // proves the session exists, never that we watched it start — so the line
  // that used to clear the flag and rewrite `startedAt` the moment any root
  // event landed is gone with it. `ensureRoot` only honours the argument on the
  // call that CREATES the node, so a root that already exists keeps whatever it
  // concluded, and `SessionStart` in `applyEvent` is the single thing that
  // clears it.
  //
  // The Codex side used to defeat this and no longer does (#684). The rollout
  // watcher skips a pre-existing session's history at startup and then minted a
  // `SessionStart` of its own for it, so a Codex session the deck joined late
  // arrived carrying the very event saying it did not — the rule below was
  // right about its input and the input was false. `ensureCodexRoot` now emits
  // that event only for a rollout the watcher opened at byte 0, so a joined-late
  // Codex session reaches this line looking like a joined-late Claude one: a
  // root conjured by its first real event, marked, with no start time asserted
  // for it.
  const root = ensureRoot(state, sessionId, now, /*synthetic*/ p.hook_event_name !== "SessionStart");
  adoptCwd(root, p);
  adoptRootLabel(root, p);
  return root;
}

export function ensureSubagent(state: GraphState, sessionId: string, key: string, p: HookPayload, now: number): AgentNodeData {
  const id = subagentIdFor(sessionId, key);
  // Make sure the root exists. A `SubagentStart` is not a `SessionStart`, so a
  // root born here is one the deck never saw begin — same rule as resolveOwner,
  // which in practice gets here first for every event that reaches the switch.
  const root = ensureRoot(state, sessionId, now, /*synthetic*/ true);

  let a = state.agents.get(id);
  if (a) {
    adoptCwd(a, p);
    adoptSubagentLabel(a, p);
    return a;
  }
  a = {
    id,
    sessionId,
    label: subagentLabel(p),
    kind: "subagent",
    parentId: root.id,
    state: "active",
    startedAt: now,
    tools: [],
    prompts: [],
    cwd: p.cwd,
    cwdBasename: basename(p.cwd),
    toolCount: 0,
    childCount: 0,
    usage: emptyUsage(),
  };
  state.agents.set(id, a);
  const pendingModel = state.pendingSubagentModels.get(id);
  if (pendingModel) {
    a.model = pendingModel;
    state.pendingSubagentModels.delete(id);
  }
  root.childCount += 1;
  return a;
}

export function pushActive(state: GraphState, sessionId: string, key: string): void {
  const arr = state.activeSubagentStack.get(sessionId) ?? [];
  // A SubagentStart can be delivered more than once — several live decks
  // appending to one events.jsonl, a hook retry, a replay of a log region whose
  // Stop only ever arrived live — and every copy carries a fresh seq, so the
  // epoch guard lets it through. Pushing unconditionally then stranded the
  // surplus copies: popActive removes exactly one, and each leftover kept
  // resolveOwner handing the root's own Pre/PostToolUse — none of which carries
  // an agent_id — to a subagent that had already finished. Back when
  // UserPromptSubmit resolved through this stack too (#675), it flipped that
  // finished node back to 'active' with endedAt cleared, past the reach of
  // pruneOldAgents forever. A key already on the stack is a re-delivery, never
  // depth: one subagent runs once.
  if (arr.includes(key)) return;
  arr.push(key);
  state.activeSubagentStack.set(sessionId, arr);
}

export function popActive(state: GraphState, sessionId: string, key: string): void {
  const arr = state.activeSubagentStack.get(sessionId);
  if (!arr) return;
  // Remove the last occurrence of this key (subagent may not be stack top if
  // multiple are running in parallel and one finishes out of order).
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === key) { arr.splice(i, 1); break; }
  }
  if (arr.length === 0) state.activeSubagentStack.delete(sessionId);
}
