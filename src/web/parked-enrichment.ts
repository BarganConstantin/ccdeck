// Enrichment that reaches a session before its card does.
//
// The server's transcript scans and watches send a session's model, name,
// usage, context, activity line and background job as last-value-wins events,
// and each enriches a root already on the board (transcript-events.ts). A page
// that joins a busy deck can be handed one before the first surviving event
// that makes the card: the ring evicts the hook events that came first, and
// what it evicted it hands back ahead of the replay (withEvictedEnrichment in
// the server's event-routes.mjs). An idle session sends none of them again, so
// a value dropped for want of a card left the card without its model, its name
// and its tokens for as long as the session stayed quiet.
//
// So the value waits, folded into the newest of its kind, and the card takes
// it the moment it is made — before the event that made it says anything of
// its own, which is newer. It still never makes a card.
import { rootAgentId, type GraphState } from "./graph-state";
import {
  applyActivityObserved, applyContextObserved, applyJobObserved, applyModelObserved, applySessionNamed,
  applyUsageObserved, stampSessionFacts,
} from "./transcript-events";
import type { HookPayload } from "./types";

/** The most sessions a page holds values for before their cards exist, the
 *  one heard from longest ago going first: more than the 200 cards a board
 *  draws, and one value of each kind apiece. */
export const PARKED_ENRICHMENT_MAX = 256;

const APPLY: Record<string, (state: GraphState, p: HookPayload, sessionId: string) => void> = {
  ModelObserved: applyModelObserved,
  UsageObserved: applyUsageObserved,
  ContextObserved: applyContextObserved,
  SessionNamed: applySessionNamed,
  ActivityObserved: applyActivityObserved,
  JobObserved: applyJobObserved,
};

type Loose = Record<string, any>;
const isObject = (v: unknown): v is Loose => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const STAMPED: Array<[string, (v: unknown) => boolean]> = [
  ["model_context_window", v => typeof v === "number" && v > 0],
  ["approval_policy", v => typeof v === "string" && v !== ""],
  ["context_tokens", v => typeof v === "number" && v >= 0],
];
const JOB_STATES = new Set(["working", "blocked", "done", "failed", "stopped"]);
const validActivity = (a: unknown): a is Loose =>
  isObject(a) && typeof a.text === "string" && a.text.trim() !== "" && Number.isFinite(a.at);

/** Two payloads of one kind for one session, as the one payload that leaves a
 *  card where the two in a row would have: the appliers' own reading of each
 *  field (transcript-events.ts) — what a payload leaves out, or holds nothing
 *  usable in, says nothing; a context merges key by key and subagent models by
 *  subagent; a title that repeats the name goes; an activity line never goes
 *  backwards; a job of `null` is gone; a usage total replaces the last whole.
 *  The server folds what the ring evicts by the same rules
 *  (evicted-enrichment.mjs). */
export function foldEnrichment(prev: HookPayload | undefined, next: HookPayload): HookPayload {
  if (!prev) return next;
  const out: Loose = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  const keep = (k: string) => { if (k in prev) out[k] = prev[k]; else delete out[k]; };
  for (const [k, ok] of STAMPED) if (!ok(next[k])) keep(k);
  switch (next.hook_event_name) {
    case "ModelObserved":
      if (!(typeof next.model === "string" && next.model !== "")) keep("model");
      if (isObject(prev.subagentModels) || isObject(next.subagentModels)) {
        out.subagentModels = {
          ...(isObject(prev.subagentModels) ? prev.subagentModels : {}),
          ...(isObject(next.subagentModels) ? next.subagentModels : {}),
        };
      }
      break;
    case "ContextObserved": {
      if (!isObject(next.context)) { keep("context"); break; }
      const ctx: Loose = isObject(prev.context) ? { ...prev.context } : {};
      for (const [k, v] of Object.entries(next.context)) if (typeof v === "number" || Array.isArray(v)) ctx[k] = v;
      out.context = ctx;
      break;
    }
    case "SessionNamed": {
      const name = nonEmpty(next.sessionName) ? next.sessionName : (prev.sessionName ?? null);
      let title = nonEmpty(next.sessionTitle) ? next.sessionTitle : (prev.sessionTitle ?? null);
      if (nonEmpty(name) && nonEmpty(title) && title.trim().toLowerCase() === name.trim().toLowerCase()) title = null;
      out.sessionName = name;
      out.sessionTitle = title;
      break;
    }
    case "ActivityObserved":
      if (!validActivity(next.activity) || (validActivity(prev.activity) && next.activity!.at < prev.activity.at)) keep("activity");
      break;
    case "JobObserved":
      if (!(next.job === null || (isObject(next.job) && JOB_STATES.has(next.job.state)))) keep("job");
      break;
    case "UsageObserved":
      if (!isObject(next.usage)) { keep("usage"); keep("usageByModel"); }
      else if (next.usageByModel === undefined) delete out.usageByModel;
      break;
  }
  return out as HookPayload;
}

/** Hold this enrichment when its session has no card yet, and answer whether
 *  it was held. A session with a card takes it at once, as it always did. */
export function parkEnrichment(state: GraphState, name: string, p: HookPayload, sessionId: string): boolean {
  if (!(name in APPLY) || state.agents.has(rootAgentId(sessionId))) return false;
  const kinds = state.parkedEnrichment.get(sessionId) ?? new Map<string, HookPayload>();
  const folded = foldEnrichment(kinds.get(name), p);
  // Re-inserted, both of them: the kinds keep the order their newest values
  // arrived in, which is the order the card takes them, and the sessions the
  // order they were last heard from in, which is the order the cap drops them.
  kinds.delete(name);
  kinds.set(name, folded);
  state.parkedEnrichment.delete(sessionId);
  state.parkedEnrichment.set(sessionId, kinds);
  while (state.parkedEnrichment.size > PARKED_ENRICHMENT_MAX) {
    const oldest = state.parkedEnrichment.keys().next().value;
    if (oldest === undefined) break;
    state.parkedEnrichment.delete(oldest);
  }
  return true;
}

/** The session's card exists now: give it what waited for it, through the
 *  same appliers as if it had arrived after the card. */
export function adoptParkedEnrichment(state: GraphState, sessionId: string): void {
  const kinds = state.parkedEnrichment.get(sessionId);
  if (!kinds || !state.agents.has(rootAgentId(sessionId))) return;
  state.parkedEnrichment.delete(sessionId);
  for (const [name, p] of kinds) {
    stampSessionFacts(state, p, sessionId);
    APPLY[name]?.(state, p, sessionId);
  }
}

/** A session left the board: nothing it was waiting for may land on a card
 *  that comes back under its id later. */
export function forgetParkedEnrichment(state: GraphState, sessionId: string): void {
  state.parkedEnrichment.delete(sessionId);
}
