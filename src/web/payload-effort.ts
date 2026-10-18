// The reasoning effort a payload states, and what a payload that states none
// means (#2155).
//
// Claude Code puts the effort on its own hook payloads: `effort: { level }`,
// the level in effect when the hook ran, "on events that fire within a tool-use
// context, such as PreToolUse, PostToolUse, Stop, and SubagentStop, when the
// current model supports the effort parameter" (the hooks reference). A
// subagent's hooks carry its own `agent_id` and its own level — skill and
// subagent frontmatter can set one — so it lands on whichever agent the
// payload names, the way the model does.
//
// THE SAME EVENTS WITHOUT IT ARE AN ANSWER TOO. Those events always carry the
// field when the model has an effort, so one of them arriving without it is a
// model that has none — a switch to one mid-session — and the chip has to stop
// showing the old level. Every other event says nothing either way. A Claude
// Code older than the field never sends it, and clearing what was never set
// costs nothing.
//
// Codex is not read here: its effort is a fact of the session, read off the
// rollout's `turn_context` and stamped on the root (stampSessionFacts).
import type { HookPayload } from "./types";

const EFFORT_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]);

/** A level as the CLIs write them: one short word. The set is not closed —
 *  each model has its own, and both CLIs have added levels before. */
export const EFFORT_LEVEL_RE = /^[a-z][a-z0-9_-]{0,23}$/i;

/**
 * The effort a Claude Code payload states for the agent it names: the level,
 * null when this event would have carried one and does not, or undefined when
 * the event says nothing about effort at all.
 */
export function claudeEffort(name: string, p: HookPayload): string | null | undefined {
  if (p.provider === "codex") return undefined;
  const level = p.effort && typeof p.effort === "object" ? p.effort.level : undefined;
  if (typeof level === "string" && EFFORT_LEVEL_RE.test(level)) return level;
  return EFFORT_EVENTS.has(name) ? null : undefined;
}
