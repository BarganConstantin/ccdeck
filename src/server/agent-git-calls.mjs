// One finished tool call out of the hook stream: who made it, where, what it
// edited and ran, whether it succeeded, and what it printed.
//
// Claude's PostToolUse carries everything in one payload — the tool's name, its
// input and its response. Codex's does not: the rollout writes the call and its
// output as two records, and codex-translate.mjs turns them into a PreToolUse
// (name + input) and a PostToolUse / PostToolUseFailure (response only) sharing
// a `tool_use_id`. So the PreToolUse is digested and held until its outcome
// arrives, and only the digest is held — a few paths and a command — never the
// patch or the script itself.
//
// Success is the event's name, as everywhere on the deck: PostToolUse is a call
// that worked, PostToolUseFailure one that did not (codex-translate.mjs reads
// Codex's own outcome line to choose between them).
//
// The agent is the payload's subagent key — `agent_id`, or the legacy
// `parent_tool_use_id` — and null for the session's main thread. A Claude
// version whose subagent tool calls carry neither is attributed to the main
// thread: the conservative answer, since a wrong subagent would be worse.
//
// Pure apart from the bounded map of calls in flight.
import { digestToolCall, toolOutputText } from "./agent-git-digest.mjs";

const OUTCOMES = new Set(["PostToolUse", "PostToolUseFailure"]);

/** The subagent a payload names, or null for the session's main thread. */
export function agentKeyOf(payload) {
  for (const k of [payload.agent_id, payload.parent_tool_use_id]) if (typeof k === "string" && k) return k;
  return null;
}

/** `claude` or `codex`: the provider a payload came from. */
export function kindOf(payload) {
  return payload.provider === "codex" ? "codex" : "claude";
}

/**
 * @typedef {object} FinishedCall
 * @property {string} sessionId
 * @property {string | null} agentId  subagent key, null for the main thread
 * @property {"claude" | "codex"} kind
 * @property {string | null} cwd      the folder the event names
 * @property {string} toolName
 * @property {string | null} toolUseId
 * @property {boolean} ok             PostToolUse (true) or PostToolUseFailure
 * @property {number} at              when the outcome was received (ms)
 * @property {string[]} edits         absolute paths the call edited
 * @property {{ command: string, cwd: string | null }[]} commands
 * @property {string} output          what it printed; "" when it ran no command
 * @property {string | null} model    the model stamped on the event, if any
 */

/**
 * @param {{ maxPending?: number }} [opts] how many Codex calls may be in flight
 *   at once before the oldest is forgotten
 */
export function createCallJoiner({ maxPending = 512 } = {}) {
  const pending = new Map(); // `${sid}\0${toolUseId}` -> { toolName, edits, commands }

  /**
   * Feed one envelope; answers the finished call it completes, or null.
   *
   * @param {{ payload?: unknown, receivedAt?: number }} envelope
   * @returns {FinishedCall | null}
   */
  function join(envelope) {
    const p = envelope && typeof envelope === "object" ? envelope.payload : null;
    if (!p || typeof p !== "object") return null;
    const sid = typeof p.session_id === "string" && p.session_id ? p.session_id : null;
    if (!sid) return null;
    const name = p.hook_event_name;
    const id = typeof p.tool_use_id === "string" && p.tool_use_id ? p.tool_use_id : null;
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : null;

    if (name === "PreToolUse") {
      // Only Codex needs the call held: Claude's outcome restates its input.
      if (kindOf(p) !== "codex" || !id || typeof p.tool_name !== "string") return null;
      const digest = digestToolCall(p.tool_name, p.tool_input, cwd);
      if (!digest.edits.length && !digest.commands.length) return null;
      const key = `${sid}\0${id}`;
      pending.delete(key);
      pending.set(key, { toolName: p.tool_name, ...digest });
      while (pending.size > maxPending) pending.delete(pending.keys().next().value);
      return null;
    }
    if (!OUTCOMES.has(name)) return null;

    let toolName;
    let digest;
    if (typeof p.tool_name === "string" && p.tool_input && typeof p.tool_input === "object") {
      toolName = p.tool_name;
      digest = digestToolCall(toolName, p.tool_input, cwd);
      if (id) pending.delete(`${sid}\0${id}`);
    } else {
      if (!id) return null;
      const key = `${sid}\0${id}`;
      const held = pending.get(key);
      if (!held) return null;
      pending.delete(key);
      ({ toolName } = held);
      digest = { edits: held.edits, commands: held.commands };
    }
    if (!digest.edits.length && !digest.commands.length) return null;
    return {
      sessionId: sid,
      agentId: agentKeyOf(p),
      kind: kindOf(p),
      cwd,
      toolName,
      toolUseId: id,
      ok: name === "PostToolUse",
      at: typeof envelope.receivedAt === "number" ? envelope.receivedAt : Date.now(),
      edits: digest.edits,
      commands: digest.commands,
      output: digest.commands.length ? toolOutputText(p) : "",
      model: typeof p.model === "string" && p.model ? p.model : null,
    };
  }

  return {
    join,
    /** Forget every call in flight — the deck's Clear. */
    clear() { pending.clear(); },
    /** Forget one session's calls in flight. */
    forget(sessionId) {
      for (const key of pending.keys()) if (key.startsWith(`${sessionId}\0`)) pending.delete(key);
    },
    /** How many calls are held. */
    get size() { return pending.size; },
  };
}
